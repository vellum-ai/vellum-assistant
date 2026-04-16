import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getConfig } from "../config/loader.js";
import type { Speed } from "../config/schemas/inference.js";
import type { LLMCallSite } from "../config/schemas/llm.js";
import { bootstrapConversation } from "../memory/conversation-bootstrap.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";
import { stripCommentLines } from "../util/strip-comment-lines.js";

const log = getLogger("filing-service");

const FILING_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

const FILING_PROMPT_TEMPLATE = `You are running a periodic knowledge base filing job. This is a background maintenance task.

## Part 1: File the buffer

Read \`pkb/buffer.md\`. For each item in the buffer:
1. Determine which topic file it belongs in. Check \`pkb/INDEX.md\` to see what topic files exist.
2. Read the target topic file, then append or integrate the new fact.
3. If the fact is important enough to always be in context, add it to \`pkb/essentials.md\` instead.
4. If the fact is a commitment, follow-up, or active project, add it to \`pkb/threads.md\`.
5. If no existing topic file fits, create a new one and update \`pkb/INDEX.md\`.

After all items are filed, clear the processed items from \`pkb/buffer.md\` (leave the file empty, don't delete it).

## Part 2: Nest

Pick 1-2 topic files from your knowledge base and review them:
- Is the information still accurate and up to date?
- Are there duplicates that should be consolidated?
- Is anything important enough to promote to \`pkb/essentials.md\`?
- Is anything in \`pkb/essentials.md\` that's no longer essential? Demote it to a topic file.
- Are any threads in \`pkb/threads.md\` completed or stale? Remove them.
- Is any file getting too long? Consider splitting it.
- Should any topic file be restructured for clarity?

Make improvements as you see fit. This is your knowledge base — keep it sharp.`;

export interface FilingDeps {
  processMessage: (
    conversationId: string,
    content: string,
    options?: { speed?: Speed; callSite?: LLMCallSite },
  ) => Promise<{ messageId: string }>;
  onConversationCreated?: (info: {
    conversationId: string;
    title: string;
  }) => void;
  getCurrentHour?: () => number;
}

export class FilingService {
  private readonly deps: FilingDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private activeRun: Promise<void> | null = null;
  private _lastRunAt: number | null = null;
  private _nextRunAt: number | null = null;

  constructor(deps: FilingDeps) {
    this.deps = deps;
  }

  get lastRunAt(): number | null {
    return this._lastRunAt;
  }

  get nextRunAt(): number | null {
    return this._nextRunAt;
  }

  start(): void {
    const config = getConfig().filing;
    if (!config.enabled) {
      log.info("Filing service disabled by config");
      this._nextRunAt = null;
      return;
    }
    if (this.timer) return;

    log.info({ intervalMs: config.intervalMs }, "Filing service started");
    this.scheduleNextRun(config.intervalMs);
    this.timer = setInterval(() => {
      this.runOnce().catch((err) => {
        log.error({ err }, "Filing runOnce failed");
      });
    }, config.intervalMs);
  }

  reconfigure(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this._nextRunAt = null;
    this.start();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this._nextRunAt = null;
    if (this.activeRun) {
      let timerId: ReturnType<typeof setTimeout>;
      const timeout = new Promise<void>((resolve) => {
        timerId = setTimeout(resolve, 5_000);
      });
      await Promise.race([this.activeRun, timeout]);
      clearTimeout(timerId!);
    }
    log.info("Filing service stopped");
  }

  async runOnce({ force = false }: { force?: boolean } = {}): Promise<boolean> {
    const config = getConfig().filing;
    if (!force && !config.enabled) return false;

    if (
      !force &&
      config.activeHoursStart != null &&
      config.activeHoursEnd != null
    ) {
      const hour = this.deps.getCurrentHour?.() ?? new Date().getHours();
      if (
        !isWithinActiveHours(
          hour,
          config.activeHoursStart,
          config.activeHoursEnd,
        )
      ) {
        log.debug("Outside active hours, skipping filing");
        this.scheduleNextRun(config.intervalMs);
        return false;
      }
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

  private scheduleNextRun(intervalMs: number): void {
    this._nextRunAt = Date.now() + intervalMs;
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

  private async executeRun(): Promise<void> {
    log.info("Running filing job");

    try {
      const config = getConfig().filing;

      const conversation = bootstrapConversation({
        conversationType: "background",
        source: "filing",
        groupId: "system:background",
        origin: "filing",
        systemHint: "Filing",
      });

      this.deps.onConversationCreated?.({
        conversationId: conversation.id,
        title: "Filing",
      });

      await this.deps.processMessage(conversation.id, FILING_PROMPT_TEMPLATE, {
        speed: config.speed,
      });

      log.info({ conversationId: conversation.id }, "Filing job completed");
    } catch (err) {
      log.error({ err }, "Filing job failed");
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
