import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getConfig } from "../config/loader.js";
import type { Speed } from "../config/schemas/inference.js";
import type { HeartbeatAlert } from "../daemon/message-protocol.js";
import { bootstrapConversation } from "../memory/conversation-bootstrap.js";
import { isTemplateContent } from "../prompts/system-prompt.js";
import { readTextFileSync } from "../util/fs.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceDir, getWorkspacePromptPath } from "../util/platform.js";
import { stripCommentLines } from "../util/strip-comment-lines.js";

const log = getLogger("heartbeat-check");

const DEFAULT_CHECKLIST = `- Check in with yourself. Read NOW.md. Is it still accurate? Update it if anything has changed.
- Think about your user. Is there anything from recent conversations you should follow up on? Anything you noticed that you should bring up?
- Have a thought. Think about something your user would find interesting or worth talking about. A follow-up, a connection you made, something you came across. Give them a reason to open a conversation.
- Check if there's anything on the horizon — events, deadlines, things they mentioned wanting to do.
- If you have a thought worth sharing, send it. A follow-up, a useful find, a check-in. Not every beat, but when it feels right.
- If something has happened since your last journal entry, write one. Even a few sentences. The journal is how future-you stays connected.`;

const REENGAGEMENT_COOLDOWN_MS = 18 * 60 * 60 * 1000; // 18 hours
const HEARTBEAT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/** @internal Exported for testing. */
export function isShallowProfile(): boolean {
  try {
    const identityPath = getWorkspacePromptPath("IDENTITY.md");
    const userPath = getWorkspacePromptPath("USER.md");
    const rawIdentity = readTextFileSync(identityPath);
    const rawUser = readTextFileSync(userPath);
    const identity = rawIdentity != null ? stripCommentLines(rawIdentity) : null;
    const user = rawUser != null ? stripCommentLines(rawUser) : null;
    return (
      isTemplateContent(identity, "IDENTITY.md") &&
      isTemplateContent(user, "USER.md")
    );
  } catch {
    return false;
  }
}

function getReengagementTimestampPath(): string {
  return join(getWorkspaceDir(), ".reengagement-ts");
}

function isReengagementCooldownElapsed(): boolean {
  const tsPath = getReengagementTimestampPath();
  if (!existsSync(tsPath)) return true;
  try {
    const lastTs = parseInt(readFileSync(tsPath, "utf-8").trim(), 10);
    if (isNaN(lastTs)) return true;
    return Date.now() - lastTs >= REENGAGEMENT_COOLDOWN_MS;
  } catch {
    return true;
  }
}

function recordReengagementTimestamp(): void {
  try {
    writeFileSync(getReengagementTimestampPath(), Date.now().toString());
  } catch {
    // Best-effort; don't block the heartbeat.
  }
}

export interface HeartbeatDeps {
  processMessage: (
    conversationId: string,
    content: string,
    options?: { speed?: Speed },
  ) => Promise<{ messageId: string }>;
  alerter: (alert: HeartbeatAlert) => void;
  onConversationCreated?: (info: {
    conversationId: string;
    title: string;
  }) => void;
  /** Override for current hour (0-23), for testing. */
  getCurrentHour?: () => number;
}

export class HeartbeatService {
  private readonly deps: HeartbeatDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private activeRun: Promise<void> | null = null;
  private _lastRunAt: number | null = null;
  private _nextRunAt: number | null = null;

  constructor(deps: HeartbeatDeps) {
    this.deps = deps;
  }

  /** Epoch-ms timestamp of the last completed heartbeat run. */
  get lastRunAt(): number | null {
    return this._lastRunAt;
  }

  /** Epoch-ms timestamp of the next scheduled heartbeat run. */
  get nextRunAt(): number | null {
    return this._nextRunAt;
  }

  start(): void {
    const config = getConfig().heartbeat;
    if (!config.enabled) {
      log.info("Heartbeat disabled by config");
      this._nextRunAt = null;
      return;
    }
    if (this.timer) return;

    log.info({ intervalMs: config.intervalMs }, "Heartbeat service started");
    this.scheduleNextRun(config.intervalMs);
    this.timer = setInterval(() => {
      this.runOnce().catch((err) => {
        log.error({ err }, "Heartbeat runOnce failed");
      });
    }, config.intervalMs);
  }

  /** Restart the timer with the latest config (e.g. after settings change). */
  reconfigure(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this._nextRunAt = null;
    this.start();
  }

  /**
   * Reset the heartbeat timer so the next run is a full interval from now.
   * Called when the guardian sends a message — no need for a heartbeat shortly
   * after an active conversation.
   */
  resetTimer(): void {
    if (!this.timer) return;
    const config = getConfig().heartbeat;
    clearInterval(this.timer);
    this.scheduleNextRun(config.intervalMs);
    this.timer = setInterval(() => {
      this.runOnce().catch((err) => {
        log.error({ err }, "Heartbeat runOnce failed");
      });
    }, config.intervalMs);
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
    log.info("Heartbeat service stopped");
  }

  /** Returns true if the heartbeat actually ran, false if skipped.
   *  When `force` is true (e.g. manual "Run Now"), skip enabled & active-hours guards. */
  async runOnce({ force = false }: { force?: boolean } = {}): Promise<boolean> {
    const config = getConfig().heartbeat;
    if (!force && !config.enabled) return false;

    // Active hours guard — only applied when both bounds are set.
    // The schema rejects configs where only one bound is provided.
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
        log.debug(
          {
            hour,
            activeHoursStart: config.activeHoursStart,
            activeHoursEnd: config.activeHoursEnd,
          },
          "Outside active hours, skipping",
        );
        this.scheduleNextRun(config.intervalMs);
        return false;
      }
    }

    // Overlap prevention
    if (this.activeRun) {
      log.debug("Previous heartbeat run still active, skipping");
      return false;
    }

    const run = this.executeRun();
    this.activeRun = run;
    try {
      await Promise.race([
        run,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Heartbeat execution timed out")),
            HEARTBEAT_TIMEOUT_MS,
          ),
        ),
      ]);
    } finally {
      this.activeRun = null;
      this._lastRunAt = Date.now();
      this.scheduleNextRun(getConfig().heartbeat.intervalMs);
    }
    return true;
  }

  private scheduleNextRun(intervalMs: number): void {
    this._nextRunAt = Date.now() + intervalMs;
  }

  private async executeRun(): Promise<void> {
    log.info("Running heartbeat");

    try {
      const config = getConfig().heartbeat;
      const checklist = this.readChecklist();
      const { prompt, includedReengagement } = this.buildPrompt(checklist);

      const conversation = bootstrapConversation({
        conversationType: "background",
        source: "heartbeat",
        groupId: "system:background",
        origin: "heartbeat",
        systemHint: "Heartbeat",
      });

      this.deps.onConversationCreated?.({
        conversationId: conversation.id,
        title: "Heartbeat",
      });

      await this.deps.processMessage(conversation.id, prompt, {
        speed: config.speed,
      });

      if (includedReengagement) {
        recordReengagementTimestamp();
      }

      log.info({ conversationId: conversation.id }, "Heartbeat completed");
    } catch (err) {
      log.error({ err }, "Heartbeat failed");
      try {
        this.deps.alerter({
          type: "heartbeat_alert",
          title: "Heartbeat Failed",
          body: err instanceof Error ? err.message : String(err),
        });
      } catch (alertErr) {
        log.warn({ alertErr }, "Failed to broadcast heartbeat alert");
      }
    }
  }

  private readChecklist(): string {
    const raw =
      readTextFileSync(getWorkspacePromptPath("HEARTBEAT.md")) ??
      DEFAULT_CHECKLIST;
    return stripCommentLines(raw);
  }

  /** @internal Exposed for testing. */
  buildPrompt(checklist: string): { prompt: string; includedReengagement: boolean } {
    let prompt = `You are running a periodic heartbeat check. Review the following checklist and take any necessary actions.

<heartbeat-checklist>
${checklist}
</heartbeat-checklist>

<heartbeat-disposition>
After completing your review, end your response with one of:
- HEARTBEAT_OK — if everything looks good, no action needed
- HEARTBEAT_ALERT — if you found issues that need attention (describe them before this marker)
</heartbeat-disposition>`;

    let includedReengagement = false;
    if (isShallowProfile() && isReengagementCooldownElapsed()) {
      includedReengagement = true;
      prompt += `\n\n<relationship-depth>\nYou don't know much about this person yet — their profile is still sparse. If the moment feels right during this beat, gently invite them to share something about themselves. Not an interrogation — something natural like "I realized I don't actually know much about what you do. Fill me in sometime?" Only do this occasionally, not every beat. If they engage, save what you learn.\n</relationship-depth>`;
    }

    return { prompt, includedReengagement };
  }
}

/**
 * Check if the given hour falls within the active window.
 * Handles overnight windows (e.g. start=22, end=6).
 */
function isWithinActiveHours(
  hour: number,
  start: number,
  end: number,
): boolean {
  if (start <= end) {
    return hour >= start && hour < end;
  }
  // Overnight window: e.g. 22-6 means 22,23,0,1,2,3,4,5
  return hour >= start || hour < end;
}
