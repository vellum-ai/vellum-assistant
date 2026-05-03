import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getConfig } from "../config/loader.js";
import type { HeartbeatConfig } from "../config/schemas/heartbeat.js";
import type { HeartbeatAlert } from "../daemon/message-protocol.js";
import { processMessage } from "../daemon/process-message.js";
import { emitFeedEvent } from "../home/emit-feed-event.js";
import { bootstrapConversation } from "../memory/conversation-bootstrap.js";
import { getConversation } from "../memory/conversation-crud.js";
import { GENERATING_TITLE } from "../memory/conversation-title-service.js";
import {
  GUARDIAN_PERSONA_TEMPLATE,
  resolveGuardianPersona,
} from "../prompts/persona-resolver.js";
import { isTemplateContent } from "../prompts/system-prompt.js";
import { computeNextRunAt } from "../schedule/recurrence-engine.js";
import { readTextFileSync } from "../util/fs.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceDir, getWorkspacePromptPath } from "../util/platform.js";
import { stripCommentLines } from "../util/strip-comment-lines.js";
import {
  completeHeartbeatRun,
  insertPendingHeartbeatRun,
  markStaleRunningAsError,
  markStaleRunsAsMissed,
  skipHeartbeatRun,
  startHeartbeatRun,
  supersedePendingRun,
} from "./heartbeat-run-store.js";

const log = getLogger("heartbeat-check");

const DEFAULT_CHECKLIST = `- Check in with yourself. Read NOW.md. Is it still accurate? Update it if anything has changed.
- Think about your user. Is there anything from recent conversations you should follow up on? Anything you noticed that you should bring up?
- Have a thought. Think about something your user would find interesting or worth talking about. A follow-up, a connection you made, something you came across. Give them a reason to open a conversation.
- Check if there's anything on the horizon — events, deadlines, things they mentioned wanting to do.
- If you have a thought worth sharing, send it. A follow-up, a useful find, a check-in. Not every beat, but when it feels right.
- If something has happened since your last journal entry, write one. Even a few sentences. The journal is how future-you stays connected.`;

const REENGAGEMENT_COOLDOWN_MS = 18 * 60 * 60 * 1000; // 18 hours
const HEARTBEAT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// Stripped-comment form of the guardian persona scaffold. Computed
// once at module load because stripping comment lines is deterministic
// and the template itself is a compile-time constant.
const GUARDIAN_PERSONA_SCAFFOLD_STRIPPED = stripCommentLines(
  GUARDIAN_PERSONA_TEMPLATE,
).trim();

/** @internal Exported for testing. */
export function isShallowProfile(): boolean {
  try {
    const identityPath = getWorkspacePromptPath("IDENTITY.md");
    const rawIdentity = readTextFileSync(identityPath);
    const identity =
      rawIdentity != null ? stripCommentLines(rawIdentity) : null;
    // `resolveGuardianPersona` returns already-stripped, trimmed content
    // (or null for missing/empty files).
    const user = resolveGuardianPersona();
    const userIsEmpty =
      user == null ||
      user.length === 0 ||
      user === GUARDIAN_PERSONA_SCAFFOLD_STRIPPED;
    return isTemplateContent(identity, "IDENTITY.md") && userIsEmpty;
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
  alerter: (alert: HeartbeatAlert) => void;
  onConversationCreated?: (info: {
    conversationId: string;
    title: string;
  }) => void;
  /** Override for current hour (0-23), for testing. */
  getCurrentHour?: () => number;
}

export class HeartbeatService {
  private static instance?: HeartbeatService;

  /** Access the running HeartbeatService instance (set at startup). */
  static getInstance(): HeartbeatService | undefined {
    return HeartbeatService.instance;
  }

  private readonly deps: HeartbeatDeps;
  private timer:
    | ReturnType<typeof setInterval>
    | ReturnType<typeof setTimeout>
    | null = null;
  private activeRun: Promise<void> | null = null;
  private _lastRunAt: number | null = null;
  private _nextRunAt: number | null = null;
  private cronMode = false;
  private stopped = false;
  private configEpoch = 0;
  private _pendingRunId: string | null = null;
  private _startupMissedCount = 0;
  private _startupCrashedCount = 0;
  private _hasRunStartupRecovery = false;

  constructor(deps: HeartbeatDeps) {
    this.deps = deps;
    HeartbeatService.instance = this;
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
    this.stopped = false;
    const config = getConfig().heartbeat;
    if (!config.enabled) {
      log.info("Heartbeat disabled by config");
      this._nextRunAt = null;
      return;
    }
    if (this.timer) return;

    if (!this._hasRunStartupRecovery) {
      this._hasRunStartupRecovery = true;
      try {
        this._startupMissedCount = markStaleRunsAsMissed();
        this._startupCrashedCount = markStaleRunningAsError();
      } catch (err) {
        log.error({ err }, "Failed to recover stale heartbeat runs on startup");
      }
      if (this._startupMissedCount > 0 || this._startupCrashedCount > 0) {
        log.info(
          {
            missedCount: this._startupMissedCount,
            crashedCount: this._startupCrashedCount,
          },
          "Recovered stale heartbeat runs on startup",
        );

        const total = this._startupMissedCount + this._startupCrashedCount;
        const today = new Date().toISOString().split("T")[0];
        void emitFeedEvent({
          source: "assistant",
          title: "Heartbeat Runs Missed",
          summary: `${total} heartbeat run${total > 1 ? "s were" : " was"} missed while the assistant was offline.`,
          dedupKey: `heartbeat:missed:${today}`,
          priority: 55,
          urgency: "high",
        }).catch((err) => {
          log.warn({ err }, "Failed to emit missed heartbeat feed event");
        });
      }
    }

    if (config.cronExpression != null) {
      this.cronMode = true;
      this.scheduleNextCronRun(config);
    } else {
      this.startIntervalMode(config);
    }
  }

  private startIntervalMode(config: HeartbeatConfig): void {
    this.cronMode = false;
    if (this.timer) {
      clearTimeout(this.timer as ReturnType<typeof setTimeout>);
      clearInterval(this.timer as ReturnType<typeof setInterval>);
      this.timer = null;
    }
    log.info(
      { intervalMs: config.intervalMs },
      "Heartbeat service started (interval mode)",
    );
    this.scheduleNextRun(config.intervalMs);
    this.timer = setInterval(() => {
      this.runOnce().catch((err) => {
        log.error({ err }, "Heartbeat runOnce failed");
      });
    }, config.intervalMs);
  }

  private scheduleNextCronRun(config: HeartbeatConfig): void {
    if (this.stopped) return;
    try {
      const nextRunAt = computeNextRunAt({
        syntax: "cron",
        expression: config.cronExpression!,
        timezone: config.timezone,
      });
      this._nextRunAt = nextRunAt;
      if (this.timer) {
        clearTimeout(this.timer as ReturnType<typeof setTimeout>);
        clearInterval(this.timer as ReturnType<typeof setInterval>);
        this.timer = null;
      }
      const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours
      const delayMs = Math.max(0, nextRunAt - Date.now());
      const epoch = this.configEpoch;
      if (delayMs > MAX_TIMEOUT_MS) {
        // Re-evaluate after 24h — the actual cron time is still far away
        this.timer = setTimeout(() => {
          if (this.configEpoch === epoch) {
            this.scheduleNextCronRun(getConfig().heartbeat);
          }
        }, MAX_TIMEOUT_MS);
      } else {
        this.timer = setTimeout(() => {
          this.runOnce()
            .catch((err) => log.error({ err }, "Cron heartbeat failed"))
            .finally(() => {
              if (this.configEpoch === epoch) {
                this.scheduleNextCronRun(getConfig().heartbeat);
              }
            });
        }, delayMs);
      }
      (this.timer as ReturnType<typeof setTimeout>).unref();
      log.info(
        { nextRunAt: new Date(nextRunAt).toISOString(), delayMs },
        "Heartbeat cron run scheduled",
      );
    } catch (err) {
      log.warn(
        { err },
        "Failed to compute next cron run, falling back to interval mode",
      );
      this.startIntervalMode(config);
    }
  }

  /** Restart the timer with the latest config (e.g. after settings change). */
  reconfigure(): void {
    this.configEpoch++;
    if (this._pendingRunId) {
      supersedePendingRun(this._pendingRunId);
      this._pendingRunId = null;
    }
    if (this.timer) {
      clearTimeout(this.timer as ReturnType<typeof setTimeout>);
      clearInterval(this.timer as ReturnType<typeof setInterval>);
      this.timer = null;
    }
    this._nextRunAt = null;
    this.cronMode = false;
    this.start();
  }

  /**
   * Reset the heartbeat timer so the next run is a full interval from now.
   * Called when the guardian sends a message — no need for a heartbeat shortly
   * after an active conversation.
   */
  resetTimer(): void {
    if (!this.timer) return;
    if (this.cronMode) {
      clearTimeout(this.timer as ReturnType<typeof setTimeout>);
      clearInterval(this.timer as ReturnType<typeof setInterval>);
      this.timer = null;
      this.scheduleNextCronRun(getConfig().heartbeat);
      return;
    }
    const config = getConfig().heartbeat;
    clearInterval(this.timer as ReturnType<typeof setInterval>);
    this.scheduleNextRun(config.intervalMs);
    this.timer = setInterval(() => {
      this.runOnce().catch((err) => {
        log.error({ err }, "Heartbeat runOnce failed");
      });
    }, config.intervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer as ReturnType<typeof setTimeout>);
      clearInterval(this.timer as ReturnType<typeof setInterval>);
      this.timer = null;
    }
    if (this._pendingRunId) {
      supersedePendingRun(this._pendingRunId);
      this._pendingRunId = null;
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

    let runId: string | null;
    let scheduledFor: number;
    if (force) {
      scheduledFor = Date.now();
      runId = insertPendingHeartbeatRun(scheduledFor);
    } else {
      runId = this._pendingRunId;
      scheduledFor = this._nextRunAt ?? Date.now();
      this._pendingRunId = null;
    }

    if (!force && !config.enabled) {
      if (runId) skipHeartbeatRun(runId, "disabled");
      return false;
    }

    // Active hours guard — only applied when both bounds are set.
    // The schema rejects configs where only one bound is provided.
    if (
      !force &&
      config.activeHoursStart != null &&
      config.activeHoursEnd != null
    ) {
      let hour: number;
      if (this.cronMode && config.timezone) {
        const parts = new Intl.DateTimeFormat("en-US", {
          timeZone: config.timezone,
          hourCycle: "h23",
          hour: "numeric",
        }).formatToParts(new Date());
        hour = Number(parts.find((p) => p.type === "hour")!.value);
      } else {
        hour = this.deps.getCurrentHour?.() ?? new Date().getHours();
      }
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
        if (runId) skipHeartbeatRun(runId, "outside_active_hours");
        if (!this.cronMode) {
          this.scheduleNextRun(config.intervalMs);
        }
        return false;
      }
    }

    // Overlap prevention
    if (this.activeRun) {
      log.debug("Previous heartbeat run still active, skipping");
      if (runId) skipHeartbeatRun(runId, "overlap");
      return false;
    }

    if (!runId) {
      runId = insertPendingHeartbeatRun(scheduledFor);
    }
    const run = this.executeRun(runId, scheduledFor);
    this.activeRun = run;
    // Clear activeRun once executeRun finishes. On timeout, runOnce releases
    // activeRun separately (see catch block below) so future runs aren't
    // permanently blocked. The .finally() handler still serves as the
    // normal-completion cleanup path and uses an identity guard to avoid
    // clearing a different run's activeRun.
    run
      .finally(() => {
        if (this.activeRun === run) {
          this.activeRun = null;
        }
      })
      .catch(() => {}); // Suppress unhandled rejection if executeRun rejects

    let timerId: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timerId = setTimeout(
          () => reject(new Error("Heartbeat execution timed out")),
          HEARTBEAT_TIMEOUT_MS,
        );
      });
      timeout.catch(() => {}); // Prevent unhandled rejection if run resolves first
      await Promise.race([run, timeout]);
    } catch (err) {
      log.warn({ err }, "Heartbeat run timed out");
      // Release activeRun so the overlap guard doesn't permanently block
      // future heartbeat runs when executeRun hangs past the timeout.
      this.activeRun = null;
      const transitioned = runId
        ? completeHeartbeatRun(runId, {
            status: "timeout",
            error: "Heartbeat execution exceeded the 30-minute timeout",
          })
        : false;
      if (transitioned) {
        const today = new Date().toISOString().split("T")[0];
        void emitFeedEvent({
          source: "assistant",
          title: "Heartbeat Timed Out",
          summary: "Heartbeat execution exceeded the 30-minute timeout.",
          dedupKey: `heartbeat:timeout:${today}`,
          priority: 55,
          urgency: "high",
        }).catch(() => {});
      }
    } finally {
      clearTimeout(timerId);
      this._lastRunAt = Date.now();
      if (!this.cronMode) {
        this.scheduleNextRun(getConfig().heartbeat.intervalMs);
      }
    }
    return true;
  }

  private scheduleNextRun(intervalMs: number): void {
    if (this._pendingRunId) {
      supersedePendingRun(this._pendingRunId);
    }
    this._nextRunAt = Date.now() + intervalMs;
    this._pendingRunId = insertPendingHeartbeatRun(this._nextRunAt);
  }

  /**
   * Run credential health checks and notify about unhealthy credentials.
   * Returns a list of unhealthy provider names so callers can gate tool usage.
   */
  private async runCredentialHealthCheck(): Promise<string[]> {
    try {
      const { checkAllCredentials } =
        await import("../credential-health/credential-health-service.js");
      const report = await checkAllCredentials();
      if (report.unhealthy.length > 0) {
        // Filter out unreachable results — CES wake/startup blips should not
        // produce user-facing credential alerts. Only actionable failures notify.
        const notifiable = report.unhealthy.filter(
          (r) => r.status !== "unreachable",
        );
        const unreachableCount = report.unhealthy.length - notifiable.length;
        if (unreachableCount > 0) {
          log.warn(
            { unreachableCount },
            "Credential backend unreachable — skipping health alerts for affected providers",
          );
        }
        if (notifiable.length > 0) {
          await this.notifyUnhealthyCredentials(notifiable);
        }
        // Only block providers for hard-failure statuses — expiring, ping_failed,
        // and unreachable are transient/still-usable and should not disable
        // provider tools. missing_scopes is a hard failure because required
        // scopes are absent and provider tools will predictably fail.
        const hardFailureStatuses = new Set([
          "revoked",
          "missing_token",
          "expired",
          "missing_scopes",
        ]);
        const hardFailures = report.unhealthy.filter((r) =>
          hardFailureStatuses.has(r.status),
        );
        return [...new Set(hardFailures.map((r) => r.provider))];
      }
    } catch (err) {
      log.error({ err }, "Credential health check failed");
      try {
        this.deps.alerter({
          type: "heartbeat_alert",
          title: "Credential Health Check Failed",
          body:
            "Could not verify OAuth credential health. " +
            (err instanceof Error ? err.message : String(err)),
        });
      } catch {
        // Last resort — alerter itself failed. Already logged above.
      }
    }
    return [];
  }

  private async notifyUnhealthyCredentials(
    results: Array<{
      connectionId: string;
      provider: string;
      accountInfo: string | null;
      status: string;
      details: string;
      missingScopes: string[];
    }>,
  ): Promise<void> {
    let emitNotificationSignal: typeof import("../notifications/emit-signal.js").emitNotificationSignal;
    try {
      ({ emitNotificationSignal } =
        await import("../notifications/emit-signal.js"));
    } catch (importErr) {
      log.error(
        { err: importErr },
        "Failed to import notification signal emitter",
      );
      return;
    }

    for (const result of results) {
      const urgency =
        result.status === "revoked" || result.status === "expired"
          ? ("high" as const)
          : ("medium" as const);

      try {
        await emitNotificationSignal({
          sourceEventName: "credential.health_alert",
          sourceChannel: "watcher",
          sourceContextId: result.connectionId,
          dedupeKey: `credential-health:${result.connectionId}:${result.status}`,
          attentionHints: {
            requiresAction: true,
            urgency,
            isAsyncBackground: true,
            visibleInSourceNow: false,
          },
          contextPayload: {
            provider: result.provider,
            accountInfo: result.accountInfo,
            status: result.status,
            details: result.details,
            missingScopes: result.missingScopes,
          },
          routingIntent: "single_channel",
          conversationMetadata: {
            source: "heartbeat",
            groupId: "system:background",
          },
        });
      } catch (err) {
        log.error(
          { err, provider: result.provider, connectionId: result.connectionId },
          "Failed to emit credential health notification",
        );
      }
    }
  }

  private async executeRun(runId: string, scheduledFor: number): Promise<void> {
    log.info("Running heartbeat");

    startHeartbeatRun(runId);

    const latenessMs = Date.now() - scheduledFor;
    const LATE_THRESHOLD_MS = 5 * 60 * 1000;

    // Credential health check — surface broken credentials proactively
    // before the LLM heartbeat prompt runs. Returns unhealthy provider
    // names so the prompt can instruct the LLM to skip those providers.
    const unhealthyProviders = await this.runCredentialHealthCheck();

    let conversationId: string | undefined;
    try {
      const checklist = this.readChecklist();
      const { prompt, includedReengagement } = this.buildPrompt(
        checklist,
        unhealthyProviders,
      );

      const conversation = bootstrapConversation({
        conversationType: "background",
        source: "heartbeat",
        groupId: "system:background",
        origin: "heartbeat",
        systemHint: "Heartbeat",
      });
      conversationId = conversation.id;

      this.deps.onConversationCreated?.({
        conversationId: conversation.id,
        title: "Heartbeat",
      });

      await processMessage(conversation.id, prompt, undefined, {
        trustContext: {
          sourceChannel: "vellum",
          trustClass: "guardian",
        },
        callSite: "heartbeatAgent",
      });

      if (includedReengagement) {
        recordReengagementTimestamp();
      }

      log.info({ conversationId: conversation.id }, "Heartbeat completed");

      const transitioned = completeHeartbeatRun(runId, {
        status: "ok",
        conversationId,
      });

      if (transitioned) {
        let title = "Heartbeat";
        try {
          const row = getConversation(conversation.id);
          if (row?.title && row.title !== GENERATING_TITLE) {
            title = row.title;
          }
        } catch {
          // Best-effort; fall back to generic title.
        }

        const today = new Date().toISOString().split("T")[0];
        void emitFeedEvent({
          source: "assistant",
          title,
          summary: "Periodic check completed. Tap to see details.",
          dedupKey: `heartbeat:ok:${today}`,
          priority: 30,
        }).catch((err) => {
          log.warn(
            { err, conversationId: conversation.id },
            "Failed to emit heartbeat feed event",
          );
        });

        if (latenessMs > LATE_THRESHOLD_MS) {
          const lateMinutes = Math.round(latenessMs / 60_000);
          void emitFeedEvent({
            source: "assistant",
            title: "Heartbeat Ran Late",
            summary: `Heartbeat ran ${lateMinutes} minutes late (scheduled for ${new Date(scheduledFor).toLocaleTimeString()}).`,
            dedupKey: `heartbeat:late:${today}`,
            priority: 45,
            urgency: "medium",
          }).catch(() => {});
        }
      }
    } catch (err) {
      log.error({ err }, "Heartbeat failed");

      const transitioned = completeHeartbeatRun(runId, {
        status: "error",
        conversationId,
        error: err instanceof Error ? err.message : String(err),
      });

      if (transitioned) {
        try {
          this.deps.alerter({
            type: "heartbeat_alert",
            title: "Heartbeat Failed",
            body: err instanceof Error ? err.message : String(err),
          });
        } catch (alertErr) {
          log.error({ alertErr }, "Failed to broadcast heartbeat alert");
        }

        const today = new Date().toISOString().split("T")[0];
        void emitFeedEvent({
          source: "assistant",
          title: "Heartbeat Failed",
          summary: `Heartbeat check failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`,
          dedupKey: `heartbeat:fail:${today}`,
          priority: 55,
          urgency: "high",
        }).catch(() => {});
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
  buildPrompt(
    checklist: string,
    unhealthyProviders: string[] = [],
  ): { prompt: string; includedReengagement: boolean } {
    let prompt = `You are running a periodic heartbeat check. Review the following checklist and take any necessary actions.

<heartbeat-checklist>
${checklist}
</heartbeat-checklist>`;

    if (unhealthyProviders.length > 0) {
      const providers = unhealthyProviders.join(", ");
      prompt += `\n\n<credential-status>
The following providers have broken or expired credentials: ${providers}.
Do NOT attempt to use tools for these providers — they will fail. Skip any checklist items that depend on them and note the outage in your summary.
</credential-status>`;
    }

    prompt += `\n\n<heartbeat-disposition>
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
