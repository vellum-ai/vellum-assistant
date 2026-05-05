import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getConfig } from "../config/loader.js";
import type { LLMCallSite } from "../config/schemas/llm.js";
import { processMessage } from "../daemon/process-message.js";
import { bootstrapConversation } from "../memory/conversation-bootstrap.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";
import { stripCommentLines } from "../util/strip-comment-lines.js";

const log = getLogger("filing-service");

const FILING_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

const FILING_PROMPT_TEMPLATE = `You are running a periodic knowledge base filing job. This is a background maintenance task focused on the buffer.

Read \`pkb/buffer.md\`. For each item in the buffer:
1. Determine which topic file(s) it belongs in. Check \`pkb/INDEX.md\` to see what topic files exist.
2. Read the target topic file(s), then integrate the new fact.
3. If the fact is important enough to always be in context, add it to \`pkb/essentials.md\` instead.
4. If the fact is a commitment, follow-up, or active project, add it to \`pkb/threads.md\`.
5. If no existing topic file fits, create a new one and update \`pkb/INDEX.md\`.

After all items are filed, clear the processed items from \`pkb/buffer.md\` (leave the file empty, don't delete it).

Do not audit, restructure, or split topic files in this job. File-size discipline and PKB hygiene are owned by the daily compaction job — focus only on draining the buffer here.`;

const COMPACTION_PROMPT_TEMPLATE = `You are running the daily PKB compaction job. This is the only place file-size discipline gets enforced — the periodic filing job intentionally skips it.

## Step 1 — Audit

List every \`.md\` file under \`pkb/\` (recursively, excluding \`pkb/archive/\`) that exceeds its budget. Use \`wc -c\` (or equivalent) to measure size in bytes.

Default budgets by file class:
- Autoloaded files (always in your context — \`pkb/INDEX.md\`, \`pkb/essentials.md\`, \`pkb/threads.md\`, \`pkb/buffer.md\`, plus anything in \`pkb/_autoinject.md\`): ≤ 15K chars each. These cost a tax on every conversation, so keep them lean.
- All other topic files: ≤ 8K chars (~1.5K tokens). This is the default bar.

If your knowledge base has files that legitimately need higher budgets (e.g. a phrasebook, a catalog, a long-form narrative bounded by a single event) or files that should be exempt from size pressure entirely, document those exceptions in \`pkb/INDEX.md\` and honor what you've written there. Don't flag a file you've already decided to grandfather.

## Step 2 — Fix the worst

Pick the single most-over-budget file from Step 1 and either split or compress it this run. One file per run is enough — the cadence is daily. Splitting strategies:
- Move sections into a sibling subdirectory keyed off the parent filename, then rewrite the original as an index pointing at the splits.
- For phrasebook-style files, replace extended analysis with one-line entries that point at the matching detail file.
- For autoloaded files, demote on-demand-only sections into topic files and link them from \`INDEX.md\`.

If no file is over budget, skip Step 2 and report that everything is within limits.

## Step 3 — Sweep

- Promote anything in \`pkb/essentials.md\` that's no longer essential to its topic file.
- Demote anything important enough to always be in context up into \`pkb/essentials.md\`.
- Remove completed or stale threads from \`pkb/threads.md\`.
- Consolidate any duplicate facts you spot during the audit.

## Step 4 — Update INDEX

If the disk shape changed (files split, files moved, files created, files removed), update \`pkb/INDEX.md\` so it reflects reality.

This is your knowledge base — keep it sharp.`;

export interface FilingDeps {
  onConversationCreated?: (info: {
    conversationId: string;
    title: string;
  }) => void;
  getCurrentHour?: () => number;
}

export class FilingService {
  private static instance?: FilingService;

  /** Access the running FilingService instance (set at startup). */
  static getInstance(): FilingService | undefined {
    return FilingService.instance;
  }

  private readonly deps: FilingDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private compactionTimer: ReturnType<typeof setInterval> | null = null;
  private activeRun: Promise<void> | null = null;
  private activeCompactionRun: Promise<void> | null = null;
  private _lastRunAt: number | null = null;
  private _nextRunAt: number | null = null;
  private _lastCompactionAt: number | null = null;
  private _nextCompactionAt: number | null = null;

  constructor(deps: FilingDeps = {}) {
    this.deps = deps;
    FilingService.instance = this;
  }

  get lastRunAt(): number | null {
    return this._lastRunAt;
  }

  get nextRunAt(): number | null {
    return this._nextRunAt;
  }

  get lastCompactionAt(): number | null {
    return this._lastCompactionAt;
  }

  get nextCompactionAt(): number | null {
    return this._nextCompactionAt;
  }

  start(): void {
    const fullConfig = getConfig();
    if (isAssistantFeatureFlagEnabled("memory-v2-enabled", fullConfig)) {
      log.info("Filing service disabled — memory v2 flag is set");
      this._nextRunAt = null;
      this._nextCompactionAt = null;
      return;
    }

    const config = fullConfig.filing;

    if (config.enabled && !this.timer) {
      log.info({ intervalMs: config.intervalMs }, "Filing service started");
      this.scheduleNextRun(config.intervalMs);
      this.timer = setInterval(() => {
        this.runOnce().catch((err) => {
          log.error({ err }, "Filing runOnce failed");
        });
      }, config.intervalMs);
    } else if (!config.enabled) {
      log.info("Filing service disabled by config");
      this._nextRunAt = null;
    }

    if (config.compactionEnabled && !this.compactionTimer) {
      log.info(
        { compactionIntervalMs: config.compactionIntervalMs },
        "Compaction service started",
      );
      this.scheduleNextCompactionRun(config.compactionIntervalMs);
      this.compactionTimer = setInterval(() => {
        this.runCompactionOnce().catch((err) => {
          log.error({ err }, "Compaction runOnce failed");
        });
      }, config.compactionIntervalMs);
    } else if (!config.compactionEnabled) {
      log.info("Compaction service disabled by config");
      this._nextCompactionAt = null;
    }
  }

  reconfigure(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.compactionTimer) {
      clearInterval(this.compactionTimer);
      this.compactionTimer = null;
    }
    this._nextRunAt = null;
    this._nextCompactionAt = null;
    this.start();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.compactionTimer) {
      clearInterval(this.compactionTimer);
      this.compactionTimer = null;
    }
    this._nextRunAt = null;
    this._nextCompactionAt = null;
    const inflight: Promise<void>[] = [];
    if (this.activeRun) inflight.push(this.activeRun);
    if (this.activeCompactionRun) inflight.push(this.activeCompactionRun);
    if (inflight.length > 0) {
      let timerId: ReturnType<typeof setTimeout>;
      const timeout = new Promise<void>((resolve) => {
        timerId = setTimeout(resolve, 5_000);
      });
      await Promise.race([Promise.all(inflight), timeout]);
      clearTimeout(timerId!);
    }
    log.info("Filing service stopped");
  }

  async runOnce({ force = false }: { force?: boolean } = {}): Promise<boolean> {
    const config = getConfig().filing;
    if (!force && !config.enabled) return false;

    if (
      !force &&
      !this.isWithinActiveHoursNow(
        config.activeHoursStart,
        config.activeHoursEnd,
      )
    ) {
      log.debug("Outside active hours, skipping filing");
      this.scheduleNextRun(config.intervalMs);
      return false;
    }

    if (this.activeRun) {
      log.debug("Previous filing run still active, skipping");
      return false;
    }

    // Skip if buffer is empty — no work to do
    if (!force && !this.hasBufferContent()) {
      log.debug("Buffer is empty, skipping filing");
      this.scheduleNextRun(config.intervalMs);
      return false;
    }

    const run = this.executeRun();
    this.activeRun = run;
    try {
      await Promise.race([
        run,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Filing execution timed out")),
            FILING_TIMEOUT_MS,
          ),
        ),
      ]);
    } finally {
      this.activeRun = null;
      this._lastRunAt = Date.now();
      this.scheduleNextRun(getConfig().filing.intervalMs);
    }
    return true;
  }

  async runCompactionOnce({
    force = false,
  }: { force?: boolean } = {}): Promise<boolean> {
    const config = getConfig().filing;
    if (!force && !config.compactionEnabled) return false;

    if (
      !force &&
      !this.isWithinActiveHoursNow(
        config.activeHoursStart,
        config.activeHoursEnd,
      )
    ) {
      log.debug("Outside active hours, skipping compaction");
      this.scheduleNextCompactionRun(config.compactionIntervalMs);
      return false;
    }

    if (this.activeCompactionRun) {
      log.debug("Previous compaction run still active, skipping");
      return false;
    }

    const run = this.executeCompactionRun();
    this.activeCompactionRun = run;
    try {
      await Promise.race([
        run,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Compaction execution timed out")),
            FILING_TIMEOUT_MS,
          ),
        ),
      ]);
    } finally {
      this.activeCompactionRun = null;
      this._lastCompactionAt = Date.now();
      this.scheduleNextCompactionRun(getConfig().filing.compactionIntervalMs);
    }
    return true;
  }

  private isWithinActiveHoursNow(
    start: number | null,
    end: number | null,
  ): boolean {
    if (start == null || end == null) return true;
    const hour = this.deps.getCurrentHour?.() ?? new Date().getHours();
    return isWithinActiveHours(hour, start, end);
  }

  private scheduleNextRun(intervalMs: number): void {
    this._nextRunAt = Date.now() + intervalMs;
  }

  private scheduleNextCompactionRun(intervalMs: number): void {
    this._nextCompactionAt = Date.now() + intervalMs;
  }

  private hasBufferContent(): boolean {
    const bufferPath = join(getWorkspaceDir(), "pkb", "buffer.md");
    if (!existsSync(bufferPath)) return false;
    try {
      const content = stripCommentLines(
        readFileSync(bufferPath, "utf-8"),
      ).trim();
      return content.length > 0;
    } catch {
      return false;
    }
  }

  private executeRun(): Promise<void> {
    return this.executeBackgroundJob({
      title: "Knowledge base filing",
      prompt: FILING_PROMPT_TEMPLATE,
      callSite: "filingAgent",
    });
  }

  private executeCompactionRun(): Promise<void> {
    return this.executeBackgroundJob({
      title: "Knowledge base compaction",
      prompt: COMPACTION_PROMPT_TEMPLATE,
      callSite: "compactionAgent",
    });
  }

  private async executeBackgroundJob(opts: {
    title: string;
    prompt: string;
    callSite: LLMCallSite;
  }): Promise<void> {
    log.info({ title: opts.title }, "Running background job");

    try {
      const conversation = bootstrapConversation({
        conversationType: "background",
        source: "filing",
        groupId: "system:background",
        origin: "filing",
        systemHint: opts.title,
      });

      this.deps.onConversationCreated?.({
        conversationId: conversation.id,
        title: opts.title,
      });

      await processMessage(conversation.id, opts.prompt, undefined, {
        trustContext: {
          sourceChannel: "vellum",
          trustClass: "guardian",
        },
        callSite: opts.callSite,
      });

      log.info(
        { conversationId: conversation.id, title: opts.title },
        "Background job completed",
      );
    } catch (err) {
      log.error({ err, title: opts.title }, "Background job failed");
    }
  }
}

function isWithinActiveHours(
  hour: number,
  start: number,
  end: number,
): boolean {
  if (start <= end) {
    return hour >= start && hour < end;
  }
  return hour >= start || hour < end;
}
