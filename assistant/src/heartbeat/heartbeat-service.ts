import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getConfig } from "../config/loader.js";
import type { HeartbeatConfig } from "../config/schemas/heartbeat.js";
import {
  checkDiskPressureBackgroundGate,
  diskPressureBackgroundSkipLogFields,
  shouldLogDiskPressureBackgroundSkip,
} from "../daemon/disk-pressure-background-gate.js";
import type { HeartbeatAlert } from "../daemon/message-protocol.js";
import { emitNotificationSignal } from "../notifications/emit-signal.js";
import {
  GUARDIAN_PERSONA_TEMPLATE,
  resolveGuardianPersona,
} from "../prompts/persona-resolver.js";
import { isTemplateContent } from "../prompts/system-prompt.js";
import { runBackgroundJob } from "../runtime/background-job-runner.js";
import { hasReceivedUserMessage } from "../runtime/pre-first-message-gate.js";
import { computeNextRunAt } from "../schedule/recurrence-engine.js";
import { readTextFileSync } from "../util/fs.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceDir, getWorkspacePromptPath } from "../util/platform.js";
import { stripCommentLines } from "../util/strip-comment-lines.js";
import {
  completeHeartbeatRun,
  countCompletedHeartbeatRuns,
  countCompletedRunsToday,
  countRecentConsecutiveRuns,
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

const EARLY_HEARTBEAT_THRESHOLD = 3;
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

function refreshBackgroundWakeIntentSoon(reason: string): void {
  void import("../background-wake/publisher.js")
    .then(({ refreshBackgroundWakeIntent }) =>
      refreshBackgroundWakeIntent(reason),
    )
    .catch((err) =>
      log.warn({ err, reason }, "Failed to queue background wake refresh"),
    );
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

export interface ManagedWakeHeartbeatRunOptions {
  now?: number;
  toleranceMs?: number;
  assumeDue?: boolean;
  scheduledFor?: number;
}

export interface ManagedWakeHeartbeatRunResult {
  due: boolean;
  completed: number;
  skipped: number;
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
  // Counter of consecutive auto-heartbeats since the last guardian message.
  // Reset by resetTimer (guardian message), reconfigure, and stop. Force runs
  // bypass the cap and do not increment.
  private _consecutiveRuns = 0;
  // Bumped every time the counter is reset so an in-flight run that finishes
  // after a guardian message can detect the reset and skip its increment.
  private _resetGeneration = 0;

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

  /** Whether the consecutive-run cap has been reached. */
  get isConsecutiveRunCapReached(): boolean {
    const config = getConfig().heartbeat;
    if (config.maxConsecutiveRuns == null) return false;
    return (
      countRecentConsecutiveRuns(config.maxConsecutiveRuns) >=
      config.maxConsecutiveRuns
    );
  }

  /** Whether the daily run cap has been reached. */
  get isDailyCapReached(): boolean {
    const config = getConfig().heartbeat;
    if (config.maxDailyRuns == null) return false;
    return countCompletedRunsToday() >= config.maxDailyRuns;
  }

  async runManagedWakeIfDue(
    options: ManagedWakeHeartbeatRunOptions = {},
  ): Promise<ManagedWakeHeartbeatRunResult> {
    const now = options.now ?? Date.now();
    const toleranceMs = options.toleranceMs ?? 0;
    const dueByLocalTimer =
      this._nextRunAt != null && this._nextRunAt <= now + toleranceMs;

    if (!dueByLocalTimer && options.assumeDue !== true) {
      return { due: false, completed: 0, skipped: 0 };
    }

    if (!dueByLocalTimer) {
      if (this._pendingRunId) {
        supersedePendingRun(this._pendingRunId);
        this._pendingRunId = null;
      }
      this._nextRunAt = options.scheduledFor ?? now;
      this._pendingRunId = insertPendingHeartbeatRun(this._nextRunAt);
    }

    const completed = await this.runOnce({ force: false });

    if (this.cronMode && !this.stopped) {
      this.scheduleNextCronRun(getConfig().heartbeat);
    }

    return {
      due: true,
      completed: completed ? 1 : 0,
      skipped: completed ? 0 : 1,
    };
  }

  start(): void {
    this.stopped = false;
    const config = getConfig().heartbeat;
    if (!config.enabled) {
      log.info("Heartbeat disabled by config");
      this._nextRunAt = null;
      refreshBackgroundWakeIntentSoon("heartbeat-disabled");
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

        if (!isDiskPressureBackgroundLocked("heartbeat-startup")) {
          const total = this._startupMissedCount + this._startupCrashedCount;
          const today = new Date().toISOString().split("T")[0];
          void emitNotificationSignal({
            sourceChannel: "scheduler",
            sourceContextId: "heartbeat",
            sourceEventName: "activity.failed",
            dedupeKey: `activity-failed:heartbeat-missed:${today}`,
            contextPayload: {
              jobName: "heartbeat",
              errorMessage: `${total} heartbeat run${
                total > 1 ? "s were" : " was"
              } missed while the assistant was offline.`,
              errorKind: "exception",
            },
            attentionHints: {
              requiresAction: false,
              urgency: "medium",
              isAsyncBackground: true,
              visibleInSourceNow: false,
            },
            conversationMetadata: {
              source: "heartbeat",
              groupId: "system:background",
              conversationType: "background",
            },
          }).catch((err) => {
            log.warn(
              { err },
              "Failed to emit missed-heartbeat activity.failed notification",
            );
          });
        }
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
      refreshBackgroundWakeIntentSoon("heartbeat-cron-scheduled");
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
    this._consecutiveRuns = 0;
    this._resetGeneration++;
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
    refreshBackgroundWakeIntentSoon("heartbeat-reconfigured");
  }

  /**
   * Reset the heartbeat timer so the next run is a full interval from now.
   * Called when the guardian sends a message — no need for a heartbeat shortly
   * after an active conversation.
   */
  resetTimer(): void {
    // Counter resets even when the timer is null so a guardian message during
    // a stopped window still clears the count.
    this._consecutiveRuns = 0;
    this._resetGeneration++;
    if (this._pendingRunId) {
      supersedePendingRun(this._pendingRunId);
      this._pendingRunId = null;
    }
    refreshBackgroundWakeIntentSoon("heartbeat-counter-reset");
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
    this._consecutiveRuns = 0;
    this._resetGeneration++;
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

    if (!force && isDiskPressureBackgroundLocked("heartbeat")) {
      return false;
    }

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
      refreshBackgroundWakeIntentSoon("heartbeat-disabled");
      return false;
    }

    // Warm-pool guard: skip heartbeats until the user has actually
    // interacted with the assistant. Heartbeats run the LLM against the
    // guardian persona, which doesn't exist in a fresh warm-pool image —
    // and even when the prompt works, surfacing "I checked in with myself"
    // chatter to a brand-new user before they've said hello is the wrong
    // first impression. The early-heartbeat counter (which special-cases
    // the first few runs) is preserved because we never reach
    // `completeHeartbeatRun` for skipped beats.
    //
    // `force=true` still runs (manual `runOnce` from an API/CLI is an
    // explicit operator action — assume they know what they're doing).
    if (!force && !hasReceivedUserMessage()) {
      log.info(
        "Heartbeat skipped — daemon has not received a first user message yet",
      );
      if (runId) skipHeartbeatRun(runId, "pre_first_user_message");
      if (!this.cronMode) {
        this.scheduleNextRun(config.intervalMs);
      }
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

    // Cap consecutive auto-runs without a guardian message so the assistant
    // stops burning LLM tokens when the user is away. Force runs (manual
    // operator action) bypass the cap and do not increment the counter.
    if (
      !force &&
      config.maxConsecutiveRuns != null &&
      this._consecutiveRuns >= config.maxConsecutiveRuns
    ) {
      log.debug(
        {
          consecutiveRuns: this._consecutiveRuns,
          maxConsecutiveRuns: config.maxConsecutiveRuns,
        },
        "Max consecutive runs reached, skipping",
      );
      if (runId) skipHeartbeatRun(runId, "max_consecutive_runs");
      if (!this.cronMode) {
        this.scheduleNextRun(config.intervalMs);
      }
      return false;
    }

    // Daily run cap — stop burning tokens when the daily budget is exhausted.
    // Force runs bypass the cap.
    if (
      !force &&
      config.maxDailyRuns != null &&
      countCompletedRunsToday() >= config.maxDailyRuns
    ) {
      log.debug(
        { maxDailyRuns: config.maxDailyRuns },
        "Daily run cap reached, skipping",
      );
      if (runId) skipHeartbeatRun(runId, "max_daily_runs");
      if (!this.cronMode) {
        this.scheduleNextRun(config.intervalMs);
      }
      return false;
    }

    // Overlap prevention
    if (this.activeRun) {
      log.debug("Previous heartbeat run still active, skipping");
      if (runId) skipHeartbeatRun(runId, "overlap");
      return false;
    }

    // The runner enforces its own timeout internally, so we don't need an
    // outer Promise.race here. The activeRun guard prevents a wedged run
    // from spawning concurrent heartbeat work; the runner's timeout is
    // what actually unblocks the in-flight run.
    if (!runId) {
      runId = insertPendingHeartbeatRun(scheduledFor);
    }
    const run = this.executeRun(runId, scheduledFor);
    this.activeRun = run;
    // Snapshot the reset generation so we can detect whether a reset (guardian
    // message, reconfigure, stop) happened while this run was in flight. If it
    // did, the counter was already zeroed and we must not undo that reset by
    // incrementing in `finally`.
    const startGeneration = this._resetGeneration;
    try {
      await run;
    } catch (err) {
      log.warn({ err }, "Heartbeat run threw");
    } finally {
      if (this.activeRun === run) {
        this.activeRun = null;
      }
      this._lastRunAt = Date.now();
      if (!force && this._resetGeneration === startGeneration) {
        this._consecutiveRuns++;
      }
      if (!this.cronMode) {
        this.scheduleNextRun(getConfig().heartbeat.intervalMs);
      }
      refreshBackgroundWakeIntentSoon("heartbeat-run-complete");
    }
    return true;
  }

  private scheduleNextRun(intervalMs: number): void {
    if (this._pendingRunId) {
      supersedePendingRun(this._pendingRunId);
    }
    this._nextRunAt = Date.now() + intervalMs;
    this._pendingRunId = insertPendingHeartbeatRun(this._nextRunAt);
    refreshBackgroundWakeIntentSoon("heartbeat-interval-scheduled");
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
            conversationType: "background",
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

    const checklist = this.readChecklist();
    const completedRunCount = countCompletedHeartbeatRuns();
    const { prompt, includedReengagement } = this.buildPrompt(
      checklist,
      unhealthyProviders,
      completedRunCount,
    );

    // Centralized boundary wrapper: handles bootstrap, processMessage,
    // timeout, and emits `activity.failed` on any failure path. Never
    // re-throws — failures come back as a structured result.
    //
    // The runner fires `onConversationCreated` synchronously after
    // bootstrap so the macOS sidebar gets the new conversation
    // immediately rather than waiting up to HEARTBEAT_TIMEOUT_MS for
    // the LLM turn to finish. If the model judges the run worth
    // surfacing to the guardian, it calls the `notifications` skill
    // directly — no in-band marker.
    let conversationId: string | undefined;
    const result = await runBackgroundJob({
      jobName: "heartbeat",
      source: "heartbeat",
      prompt,
      systemHint: "Heartbeat",
      trustContext: {
        sourceChannel: "vellum",
        trustClass: "guardian",
      },
      callSite: "heartbeatAgent",
      timeoutMs: HEARTBEAT_TIMEOUT_MS,
      origin: "heartbeat",
      deferNotifications: true,
      onConversationCreated: (newConversationId) => {
        conversationId = newConversationId;
        this.deps.onConversationCreated?.({
          conversationId: newConversationId,
          title: "Heartbeat",
        });
      },
    });

    if (result.ok) {
      if (includedReengagement) {
        recordReengagementTimestamp();
      }
      log.info(
        { conversationId: result.conversationId },
        "Heartbeat completed",
      );

      // Mark the run record as ok. The runner owns failure emission via
      // `activity.failed`; any user-facing alert the model decided to
      // raise was emitted in-band via the `notifications` skill during
      // the turn itself.
      const transitioned = completeHeartbeatRun(runId, {
        status: "ok",
        conversationId: result.conversationId,
      });

      if (transitioned && latenessMs > LATE_THRESHOLD_MS) {
        const lateMinutes = Math.round(latenessMs / 60_000);
        log.warn(
          {
            latenessMs,
            lateMinutes,
            scheduledFor,
            runId,
          },
          "Heartbeat ran late",
        );
      }
      return;
    }

    log.error(
      { err: result.error, errorKind: result.errorKind },
      "Heartbeat failed",
    );

    // The runner has already emitted `activity.failed` for the failure;
    // we still record the run-level error and broadcast the in-app
    // heartbeat alert so the existing surfacing keeps working.
    // Map the runner's error classification onto the run-store's status
    // enum so the run history preserves the timeout / error distinction.
    const runStatus = result.errorKind === "timeout" ? "timeout" : "error";
    const transitioned = completeHeartbeatRun(runId, {
      status: runStatus,
      conversationId: conversationId ?? result.conversationId,
      error: result.error?.message ?? "Unknown error",
    });

    // Only fire the in-app alerter when our completion is the one that
    // actually wrote — otherwise a parallel finalizer (e.g. a startup
    // recovery sweep) already alerted for this run.
    if (transitioned) {
      try {
        this.deps.alerter({
          type: "heartbeat_alert",
          title: "Heartbeat Failed",
          body: result.error?.message ?? "Unknown error",
        });
      } catch (alertErr) {
        log.error({ alertErr }, "Failed to broadcast heartbeat alert");
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
    completedRunCount: number = Infinity,
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

    const disposition = getConfig().heartbeat.disposition;
    if (disposition) {
      prompt += `\n\n<heartbeat-disposition>\n${disposition}\n</heartbeat-disposition>`;
    }

    if (completedRunCount < EARLY_HEARTBEAT_THRESHOLD) {
      prompt += `\n\n<early-heartbeat>
This is one of your first heartbeats. Your user hasn't heard from you yet and may not know you're here. Find something genuinely useful to share — a follow-up from a recent conversation, something you noticed, or a quick check-in. Lean toward surfacing it via the notifications skill this time. First impressions matter.
</early-heartbeat>`;
    }

    let includedReengagement = false;
    if (isShallowProfile() && isReengagementCooldownElapsed()) {
      includedReengagement = true;
      prompt += `\n\n<relationship-depth>\nYou don't know much about this person yet — their profile is still sparse. If the moment feels right during this beat, gently invite them to share something about themselves. Not an interrogation — something natural like "I realized I don't actually know much about what you do. Fill me in sometime?" Only do this occasionally, not every beat. If they engage, save what you learn.\n</relationship-depth>`;
    }

    return { prompt, includedReengagement };
  }
}

function isDiskPressureBackgroundLocked(logKey: string): boolean {
  const diskPressureGate = checkDiskPressureBackgroundGate("background-work");
  if (diskPressureGate.action === "allow") return false;
  if (shouldLogDiskPressureBackgroundSkip(logKey)) {
    log.warn(
      {
        source: "heartbeat",
        ...diskPressureBackgroundSkipLogFields(diskPressureGate),
      },
      "Heartbeat skipped during disk pressure cleanup mode",
    );
  }
  return true;
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
