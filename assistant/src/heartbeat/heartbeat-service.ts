import { getConfig } from "../config/loader.js";
import type { Speed } from "../config/schemas/inference.js";
import type { HeartbeatAlert } from "../daemon/message-protocol.js";
import { bootstrapConversation } from "../memory/conversation-bootstrap.js";
import { readTextFileSync } from "../util/fs.js";
import { getLogger } from "../util/logger.js";
import { getWorkspacePromptPath } from "../util/platform.js";
import { stripCommentLines } from "../util/strip-comment-lines.js";

const log = getLogger("heartbeat-check");

const DEFAULT_CHECKLIST = `- Check in with yourself. Read NOW.md. Is it still accurate? Update it if anything has changed.
- Think about your user. Is there anything from recent conversations you should follow up on? Anything you noticed that you should bring up?
- Check if there's anything on the horizon — events, deadlines, things they mentioned wanting to do.
- If you have a thought worth sharing, send it. A follow-up, a useful find, a check-in. Not every beat, but when it feels right.`;

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
      await run;
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
      const prompt = this.buildPrompt(checklist);

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
  buildPrompt(checklist: string): string {
    return `You are running a periodic heartbeat check. Review the following checklist and take any necessary actions.

<heartbeat-checklist>
${checklist}
</heartbeat-checklist>

<heartbeat-disposition>
After completing your review, end your response with one of:
- HEARTBEAT_OK — if everything looks good, no action needed
- HEARTBEAT_ALERT — if you found issues that need attention (describe them before this marker)
</heartbeat-disposition>`;
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
