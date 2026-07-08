import { refreshBackgroundWakeIntent } from "../background-wake/publisher.js";
import { getConfig } from "../config/loader.js";
import type { TurnFailure } from "../daemon/conversation-agent-loop.js";
import {
  checkDiskPressureBackgroundGate,
  diskPressureBackgroundSkipLogFields,
  shouldLogDiskPressureBackgroundSkip,
} from "../daemon/disk-pressure-background-gate.js";
import { processMessage } from "../daemon/process-message.js";
import { INTERNAL_GUARDIAN_TRUST_CONTEXT } from "../daemon/trust-context.js";
import { emitNotificationSignal } from "../notifications/emit-signal.js";
import { bootstrapConversation } from "../persistence/conversation-bootstrap.js";
import { getConversation } from "../persistence/conversation-crud.js";
import { invalidateAssistantInferredItemsForConversation } from "../plugins/defaults/memory/task-memory-cleanup.js";
import { wakeAgentForOpportunity } from "../runtime/agent-wake.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import { runBackgroundJob } from "../runtime/background-job-runner.js";
import { publishConversationListChanged } from "../runtime/sync/resource-sync-events.js";
import { runSequencesOnce } from "../sequence/engine.js";
import { areCoreToolsInitialized } from "../tools/registry.js";
import { getLogger } from "../util/logger.js";
import { runWatchersOnce } from "../watcher/engine.js";
import { normalizeCapabilityManifest } from "../workflows/capabilities.js";
import { getWorkflowRunManager } from "../workflows/run-manager.js";
import { hasSetConstructs } from "./recurrence-engine.js";
import { applyRetryDecision, decideRetry } from "./retry-policy.js";
import { runScript, type ScriptResult } from "./run-script.js";
import {
  claimDueSchedules,
  completeOneShot,
  completeScheduleRun,
  createScheduleRun,
  deferClaimedSchedule,
  failOneShotPermanently,
  getLastScheduleConversationId,
  listSchedules,
  resetRetryCount,
  retryOneShot,
  type RoutingIntent,
  type ScheduleJob,
  scheduleRetry,
  setScheduleRunConversationId,
} from "./schedule-store.js";
import {
  startScheduleWorkerIfEnabled,
  stopScheduleWorker,
} from "./worker-control.js";

const log = getLogger("scheduler");

import type { ScheduleMessageOptions } from "./scheduler-types.js";

/**
 * Run a scheduled message through the daemon's agent pipeline, translating the
 * schedule's `trustClass` into the trust context `processMessage` expects.
 *
 * Returns the turn's failure outcome (if any) so the caller can record a run
 * whose LLM call failed as an error. Such a turn resolves normally rather than
 * throwing, so `turnFailure` is the only failure signal on the happy return.
 */
async function dispatchScheduleMessage(
  conversationId: string,
  message: string,
  options?: ScheduleMessageOptions,
): Promise<{ turnFailure?: TurnFailure }> {
  const { turnFailure } = await processMessage(
    conversationId,
    message,
    options
      ? {
          ...(options.trustClass
            ? {
                trustContext: {
                  sourceChannel: "vellum",
                  trustClass: options.trustClass,
                },
              }
            : {}),
          ...(options.taskRunId ? { taskRunId: options.taskRunId } : {}),
          ...(options.overrideProfile
            ? { overrideProfile: options.overrideProfile }
            : {}),
          ...(options.cronRunId ? { cronRunId: options.cronRunId } : {}),
        }
      : undefined,
  );
  return { ...(turnFailure ? { turnFailure } : {}) };
}

/** Build a schedule-run error message from a turn's failure outcome. */
function describeTurnFailure(turnFailure: TurnFailure): string {
  return turnFailure.failureCode
    ? `Agent turn failed during its LLM call (${turnFailure.failureCode})`
    : "Agent turn failed during its LLM call";
}

/** Emit the attention signal for a `notify`-mode schedule firing. */
async function emitScheduleNotifySignal(payload: {
  id: string;
  label: string;
  message: string;
  routingIntent: RoutingIntent;
  routingHints: Record<string, unknown>;
}): Promise<void> {
  await emitNotificationSignal({
    sourceEventName: "schedule.notify",
    sourceChannel: "scheduler",
    sourceContextId: payload.id,
    attentionHints: {
      requiresAction: true,
      urgency: "high",
      isAsyncBackground: false,
      visibleInSourceNow: false,
    },
    contextPayload: {
      scheduleId: payload.id,
      label: payload.label,
      message: payload.message,
    },
    routingIntent: payload.routingIntent,
    routingHints: payload.routingHints,
    conversationMetadata: {
      groupId: "system:scheduled",
      scheduleJobId: payload.id,
      source: "schedule",
    },
    dedupeKey: `schedule:notify:${payload.id}:${Date.now()}`,
    throwOnError: true,
  });
}

/** Emit the attention signal for a watcher notification. */
function emitWatcherNotifySignal(notification: {
  title: string;
  body: string;
}): void {
  void emitNotificationSignal({
    sourceEventName: "watcher.notification",
    sourceChannel: "watcher",
    sourceContextId: `watcher-${Date.now()}`,
    attentionHints: {
      requiresAction: false,
      urgency: "low",
      isAsyncBackground: true,
      visibleInSourceNow: false,
    },
    contextPayload: {
      title: notification.title,
      body: notification.body,
    },
    dedupeKey: `watcher:notification:${crypto.randomUUID()}`,
  });
}

/** Broadcast + refresh the conversation list when a schedule creates one. */
function broadcastScheduleConversationCreated(info: {
  conversationId: string;
  scheduleJobId: string;
  title: string;
}): void {
  broadcastMessage({
    type: "schedule_conversation_created",
    conversationId: info.conversationId,
    scheduleJobId: info.scheduleJobId,
    title: info.title,
  });
  publishConversationListChanged("created");
}

export interface SchedulerHandle {
  runOnce(): Promise<number>;
  runDueWorkOnce(
    options?: SchedulerRunDueWorkOptions,
  ): Promise<SchedulerDueWorkResult>;
  stop(): void;
}

export interface SchedulerRunDueWorkOptions {
  now?: number;
  deadlineAt?: number;
  minStartBudgetMs?: number;
  includeStillPending?: boolean;
}

export interface SchedulerDueWorkResult {
  claimed: number;
  completed: number;
  failed: number;
  skipped: number;
  stillPending: number;
}

const TICK_INTERVAL_MS = 15_000;

/**
 * Maximum number of times a wake can be retried after a timeout before
 * being permanently failed. At 15-second scheduler intervals, 20 retries
 * ≈ 5 minutes of total retry window.
 */
const WAKE_MAX_RETRIES = 20;

/**
 * Apply retry policy on schedule-execution failure. Retries are scheduled by
 * `applyRetryDecision`; once retries are exhausted, the `emitAlert` callback
 * fires an `activity.failed` notification so the user sees that a job
 * permanently failed rather than just silently disappearing.
 */
async function handleExecutionFailure(params: {
  job: ScheduleJob;
  errorMsg: string;
  isOneShot: boolean;
}): Promise<void> {
  const decision = decideRetry(params.job);
  await applyRetryDecision({
    job: params.job,
    isOneShot: params.isOneShot,
    errorMsg: params.errorMsg,
    decision,
    scheduleRetry,
    failOneShotPermanently,
    resetRetryCount,
    emitAlert: (_title, _summary, dedupKey) =>
      emitScheduleActivityFailed({
        jobId: params.job.id,
        jobName: params.job.name,
        errorMessage: params.errorMsg,
        dedupKey,
      }),
    log,
  });
}

/** The running scheduler, retained so shutdown can stop it. */
let instance: SchedulerHandle | null = null;

export function startScheduler(): SchedulerHandle {
  // When the schedule worker owns schedule execution, spawn it now as a child
  // of the daemon so it is running immediately. Fire-and-forget — a worker
  // failure must never block boot, and every tick below re-reads the flag so
  // ownership stays consistent either way.
  startScheduleWorkerIfEnabled();

  let stopped = false;
  let tickRunning = false;

  const tick = async () => {
    if (stopped || tickRunning) {
      return;
    }
    tickRunning = true;
    try {
      await runScheduleOnce();
    } catch (err) {
      log.error({ err }, "Schedule tick failed");
    } finally {
      tickRunning = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, TICK_INTERVAL_MS);
  timer.unref();
  void tick();

  instance = {
    async runOnce(): Promise<number> {
      return runScheduleOnce();
    },
    async runDueWorkOnce(
      options?: SchedulerRunDueWorkOptions,
    ): Promise<SchedulerDueWorkResult> {
      return runScheduleDueWorkOnce(options);
    },
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };

  // Publish the initial background wake intent now that the scheduler is live
  // and its schedules are visible to `computeNextBackgroundWakeIntent`.
  refreshBackgroundWakeIntent("daemon-startup");

  return instance;
}

/**
 * Stop the running scheduler if one was started, and SIGTERM the schedule
 * worker process if one is running. The worker stop is keyed off live state
 * rather than config: it may have been spawned at startup or out of band via
 * `assistant schedules worker start`.
 */
export function stopScheduler(): void {
  stopScheduleWorker();
  if (!instance) {
    return;
  }
  instance.stop();
  instance = null;
}

/** The running scheduler, or null if one was never started. */
export function getScheduler(): SchedulerHandle | null {
  return instance;
}

export async function runScheduleOnce(): Promise<number> {
  const result = await runScheduleDueWorkOnce();
  return result.completed + result.failed + result.skipped;
}

/**
 * True while the schedule worker process owns schedule execution. Read from
 * config on every call so a runtime `assistant schedules worker start`/`stop`
 * switches ownership without a restart.
 */
function scheduleWorkerOwnsSchedules(): boolean {
  return getConfig().schedules?.worker?.enabled === true;
}

export async function runScheduleDueWorkOnce(
  options: SchedulerRunDueWorkOptions = {},
): Promise<SchedulerDueWorkResult> {
  const now = options.now ?? Date.now();
  const minStartBudgetMs = options.minStartBudgetMs ?? 0;
  // While `schedules.worker.enabled` is set, the schedule worker process owns
  // schedule execution: this process leaves every due schedule unclaimed so
  // exactly one process runs them, and reports none of them as its own
  // pending work. The flag is re-read from config every tick, so `assistant
  // schedules worker start`/`stop` switch ownership without a restart.
  // Watchers and sequences below always run in the daemon.
  const workerOwnsSchedules = scheduleWorkerOwnsSchedules();
  const countStillPending = (at: number): number =>
    options.includeStillPending && !workerOwnsSchedules
      ? countDueScheduleJobs(at)
      : 0;
  const result: SchedulerDueWorkResult = {
    claimed: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    stillPending: 0,
  };

  if (
    options.deadlineAt != null &&
    options.deadlineAt - Date.now() < minStartBudgetMs
  ) {
    result.stillPending = countStillPending(now);
    result.skipped = result.stillPending;
    return result;
  }

  const diskPressureGate = checkDiskPressureBackgroundGate("background-work");
  if (diskPressureGate.action === "skip") {
    if (shouldLogDiskPressureBackgroundSkip("scheduler")) {
      log.warn(
        {
          source: "schedule",
          ...diskPressureBackgroundSkipLogFields(diskPressureGate),
        },
        "Schedule tick skipped during disk pressure cleanup mode",
      );
    }
    result.stillPending = countStillPending(now);
    return result;
  }

  // ── Schedules (recurring cron/RRULE + one-shot) ─────────────────────
  if (!workerOwnsSchedules) {
    const schedules = await runDueSchedulesOnce(now);
    result.claimed = schedules.claimed;
    result.completed += schedules.completed;
    result.failed += schedules.failed;
    result.skipped += schedules.skipped;
  }

  // ── Watchers (event-driven polling) ────────────────────────────────
  try {
    const watcherProcessed = await runWatchersOnce(emitWatcherNotifySignal);
    result.completed += watcherProcessed;
  } catch (err) {
    log.error({ err }, "Watcher tick failed");
  }

  // ── Sequences (multi-step outreach) ──────────────────────────────
  try {
    const sequenceProcessed = await runSequencesOnce();
    result.completed += sequenceProcessed;
  } catch (err) {
    log.error({ err }, "Sequence engine tick failed");
  }

  result.stillPending = countStillPending(Date.now());
  const processed = result.completed + result.failed + result.skipped;
  if (processed > 0) {
    log.info({ processed }, "Schedule tick complete");
  }
  return result;
}

/**
 * Claim and execute every due schedule (all modes: notify, script, wake,
 * workflow, execute). Called from the daemon's tick while
 * `schedules.worker.enabled` is off, and from the schedule worker process's
 * tick while it is on. Claims are atomic in the schedule store, so a process
 * whose view of the flag lags a tick behind cannot double-run a job another
 * process already claimed.
 */
export async function runDueSchedulesOnce(
  now: number = Date.now(),
): Promise<Omit<SchedulerDueWorkResult, "stillPending">> {
  const result = { claimed: 0, completed: 0, failed: 0, skipped: 0 };
  const mark = (status: "completed" | "failed" | "skipped") => {
    result[status] += 1;
  };

  const diskPressureGate = checkDiskPressureBackgroundGate("background-work");
  if (diskPressureGate.action === "skip") {
    if (shouldLogDiskPressureBackgroundSkip("scheduler-schedules")) {
      log.warn(
        {
          source: "schedule",
          ...diskPressureBackgroundSkipLogFields(diskPressureGate),
        },
        "Due-schedule run skipped during disk pressure cleanup mode",
      );
    }
    return result;
  }

  const jobs = await claimDueSchedules(now);
  result.claimed = jobs.length;
  for (const job of jobs) {
    const isOneShot = job.expression == null;

    // ── Notify mode (one-shot or recurring) ─────────────────────────
    if (job.mode === "notify") {
      let failed = false;
      try {
        log.info(
          { jobId: job.id, name: job.name, isOneShot },
          "Firing schedule notification",
        );
        await emitScheduleNotifySignal({
          id: job.id,
          label: job.name,
          message: job.message,
          routingIntent: job.routingIntent,
          routingHints: job.routingHints,
        });
        if (isOneShot) {
          const successRunId = await createScheduleRun(
            job.id,
            `notify-ok:${job.id}`,
          );
          await completeScheduleRun(successRunId, { status: "ok" });
          await completeOneShot(job.id);
        } else {
          // Track recurring notify-mode success so lastStatus resets to ok
          // and retryCount clears after a transient failure.
          const runId = await createScheduleRun(job.id, `notify-ok:${job.id}`);
          await completeScheduleRun(runId, { status: "ok" });
        }
      } catch (err) {
        log.warn(
          { err, jobId: job.id, name: job.name, isOneShot },
          "Schedule notification failed",
        );
        const errorMsg = err instanceof Error ? err.message : String(err);
        const errorRunId = await createScheduleRun(
          job.id,
          `notify-error:${job.id}`,
        );
        await completeScheduleRun(errorRunId, {
          status: "error",
          error: errorMsg,
        });
        await handleExecutionFailure({ job, errorMsg, isOneShot });
        failed = true;
      }
      mark(failed ? "failed" : "completed");
      continue;
    }

    // ── Script mode (shell command, no LLM) ────────────────────────
    if (job.mode === "script") {
      if (!job.script) {
        log.warn(
          { jobId: job.id, name: job.name },
          "Script schedule has no script command — skipping",
        );
        mark("skipped");
        continue;
      }
      const runId = await createScheduleRun(job.id, `script:${job.id}`);
      let failed = false;
      try {
        log.info(
          { jobId: job.id, name: job.name, isOneShot },
          "Executing script schedule",
        );
        const result: ScriptResult = await runScript(job.script, {
          timeoutMs: job.timeoutMs ?? undefined,
          scheduleRunId: runId,
          scheduleId: job.id,
        });
        await completeScheduleRun(runId, {
          status: result.exitCode === 0 ? "ok" : "error",
          output: result.stdout || undefined,
          error: result.stderr || undefined,
        });
        if (result.exitCode === 0) {
          if (isOneShot) {
            await completeOneShot(job.id);
          }
        } else {
          const errorMsg =
            result.stderr || "Script exited with non-zero status";
          await handleExecutionFailure({ job, errorMsg, isOneShot });
          failed = true;
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        log.warn(
          { err, jobId: job.id, name: job.name, isOneShot },
          "Script schedule execution failed",
        );
        await completeScheduleRun(runId, { status: "error", error: errorMsg });
        await handleExecutionFailure({ job, errorMsg, isOneShot });
        failed = true;
      }
      mark(failed ? "failed" : "completed");
      continue;
    }

    // ── Wake mode (resume an existing conversation) ─────────────────
    if (job.mode === "wake") {
      const { wakeConversationId } = job;
      if (!wakeConversationId) {
        log.warn(
          { jobId: job.id, name: job.name },
          "Wake schedule missing wakeConversationId — completing as no-op",
        );
        if (isOneShot) {
          await completeOneShot(job.id);
        }
        mark("skipped");
        continue;
      }

      let failed = false;
      try {
        log.info(
          { jobId: job.id, name: job.name, wakeConversationId, isOneShot },
          "Executing wake schedule",
        );
        const result = await wakeAgentForOpportunity({
          conversationId: wakeConversationId,
          hint: job.message,
          source: "defer",
          persistTriggerAsEvent: true,
          ...(job.inferenceProfile
            ? { forceOverrideProfile: job.inferenceProfile }
            : {}),
        });

        if (result.reason === "timeout" && isOneShot) {
          // The conversation is busy processing a tool call. Retry on
          // the next scheduler tick unless we've exceeded the retry cap.
          if (job.retryCount >= WAKE_MAX_RETRIES) {
            log.warn(
              {
                jobId: job.id,
                name: job.name,
                wakeConversationId,
                retryCount: job.retryCount,
              },
              "Wake timed out and exceeded max retries — permanently failing",
            );
            await failOneShotPermanently(job.id);
          } else {
            log.warn(
              {
                jobId: job.id,
                name: job.name,
                wakeConversationId,
                retryCount: job.retryCount,
              },
              "Wake timed out waiting for idle conversation — will retry on next tick",
            );
            await retryOneShot(job.id);
          }
          mark("skipped");
          continue;
        }

        // Guard: if the wake was not invoked for any reason (timeout on
        // a recurring schedule, not_found, archived, no_resolver), skip
        // the success feed event — the wake did not actually fire.
        if (!result.invoked) {
          log.warn(
            {
              jobId: job.id,
              name: job.name,
              wakeConversationId,
              reason: result.reason,
            },
            "Wake not invoked; skipping feed event",
          );
          if (isOneShot) {
            await completeOneShot(job.id);
          }
          mark("skipped");
          continue;
        }

        if (isOneShot) {
          const successRunId = await createScheduleRun(
            job.id,
            `wake-ok:${job.id}`,
          );
          await completeScheduleRun(successRunId, { status: "ok" });
          await completeOneShot(job.id);
        }
      } catch (err) {
        log.warn(
          { err, jobId: job.id, name: job.name, wakeConversationId, isOneShot },
          "Wake schedule execution failed",
        );
        const errorMsg = err instanceof Error ? err.message : String(err);
        const wakeErrorRunId = await createScheduleRun(
          job.id,
          `wake-error:${job.id}`,
        );
        await completeScheduleRun(wakeErrorRunId, {
          status: "error",
          error: errorMsg,
        });
        await handleExecutionFailure({ job, errorMsg, isOneShot });
        failed = true;
      }
      mark(failed ? "failed" : "completed");
      continue;
    }

    // ── Workflow mode (trigger a saved workflow by name) ────────────
    if (job.mode === "workflow") {
      if (!job.workflowName) {
        log.warn(
          { jobId: job.id, name: job.name },
          "Workflow schedule has no workflowName — skipping",
        );
        mark("skipped");
        continue;
      }
      // Boot race: the scheduler starts before initializeProvidersAndTools()
      // registers the read-only baseline (file_read/web_fetch/etc.) that
      // resolveCapabilities grants to every workflow run. Launching now would
      // give the run an EMPTY baseline and degrade/fail it. Defer the claimed
      // job back to due so it fires on a later tick once tools are registered
      // (the window is just the few seconds of daemon boot). Non-workflow modes
      // don't depend on the baseline, so only this branch gates.
      if (!areCoreToolsInitialized()) {
        log.info(
          { jobId: job.id, name: job.name, workflowName: job.workflowName },
          "Deferring workflow schedule until tools are registered",
        );
        await deferClaimedSchedule(job.id);
        mark("skipped");
        continue;
      }
      const runId = await createScheduleRun(job.id, `workflow:${job.id}`);
      let failed = false;
      try {
        log.info(
          {
            jobId: job.id,
            name: job.name,
            workflowName: job.workflowName,
            isOneShot,
          },
          "Triggering workflow schedule",
        );
        const { runId: workflowRunId } = getWorkflowRunManager().start({
          name: job.workflowName,
          args: job.workflowArgs ?? {},
          // Where the completion summary is delivered (an agent wake). Prefer an
          // explicit wake target, then fall back to the conversation that
          // created the schedule — workflow schedules made via `schedule_create`
          // store that as `createdFromConversationId` and leave
          // `wakeConversationId` unset, so without this fallback their result
          // would surface only to live SSE listeners / the DB, never delivered.
          conversationId:
            job.wakeConversationId ??
            job.createdFromConversationId ??
            undefined,
          // The schedule's persisted capability manifest scopes the run; a
          // legacy schedule with null `capabilities` normalizes to the read-only
          // baseline.
          manifest: normalizeCapabilityManifest(job.capabilities),
          trustContext: INTERNAL_GUARDIAN_TRUST_CONTEXT,
        });
        // `start` launches the run fire-and-forget and returns synchronously;
        // a successful trigger is recorded as ok. Workflow completion/failure
        // is surfaced out-of-band via workflow events and the completion wake.
        await completeScheduleRun(runId, {
          status: "ok",
          output: `workflow run ${workflowRunId} started`,
        });
        if (isOneShot) {
          await completeOneShot(job.id);
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        log.warn(
          { err, jobId: job.id, name: job.name, isOneShot },
          "Workflow schedule trigger failed",
        );
        await completeScheduleRun(runId, { status: "error", error: errorMsg });
        await handleExecutionFailure({ job, errorMsg, isOneShot });
        failed = true;
      }
      mark(failed ? "failed" : "completed");
      continue;
    }

    // ── Execute mode ────────────────────────────────────────────────

    // Check if message is a task invocation (run_task:<task_id>)
    const taskMatch = job.message.match(/^run_task:(\S+)$/);
    if (taskMatch) {
      const taskId = taskMatch[1];
      const isRruleSet =
        job.syntax === "rrule" &&
        job.expression != null &&
        hasSetConstructs(job.expression);
      const runId = await createScheduleRun(job.id, null);
      let failed = false;
      try {
        log.info(
          {
            jobId: job.id,
            name: job.name,
            taskId,
            syntax: job.syntax,
            expression: job.expression,
            isRruleSet,
            isOneShot,
          },
          "Executing scheduled task",
        );
        const { runTask } = await import("../tasks/task-runner.js");
        const result = await runTask(
          {
            taskId,
            workingDir: process.cwd(),
            source: "schedule",
            scheduleJobId: job.id,
          },
          async (conversationId, message, taskRunId) => {
            await dispatchScheduleMessage(conversationId, message, {
              trustClass: "guardian",
              taskRunId,
              cronRunId: runId,
              ...(job.inferenceProfile
                ? { overrideProfile: job.inferenceProfile }
                : {}),
            });
          },
        );

        await setScheduleRunConversationId(runId, result.conversationId);
        broadcastScheduleConversationCreated({
          conversationId: result.conversationId,
          scheduleJobId: job.id,
          title: result.status === "failed" ? `${job.name}: Error` : job.name,
        });

        if (result.status === "failed") {
          const errorMessage = result.error ?? "Task run failed";
          await completeScheduleRun(runId, {
            status: "error",
            error: errorMessage,
          });
          emitTaskActivityFailed({
            taskId,
            conversationId: result.conversationId,
            errorMessage,
          });
          await handleExecutionFailure({
            job,
            errorMsg: errorMessage,
            isOneShot,
          });
          failed = true;
        } else {
          await completeScheduleRun(runId, { status: "ok" });
          if (isOneShot) {
            await completeOneShot(job.id);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(
          {
            err,
            jobId: job.id,
            name: job.name,
            taskId,
            syntax: job.syntax,
            expression: job.expression,
            isRruleSet,
            isOneShot,
          },
          "Scheduled task execution failed",
        );
        // Create a fallback conversation for the schedule run record
        const fallbackConversation = await bootstrapConversation({
          conversationType: "scheduled",
          source: "schedule",
          scheduleJobId: job.id,
          groupId: "system:scheduled",
          origin: "schedule",
          systemHint: `Schedule: ${job.name}`,
        });
        broadcastScheduleConversationCreated({
          conversationId: fallbackConversation.id,
          scheduleJobId: job.id,
          title: `${job.name}: Error`,
        });
        await setScheduleRunConversationId(runId, fallbackConversation.id);
        await completeScheduleRun(runId, { status: "error", error: message });
        emitTaskActivityFailed({
          taskId,
          conversationId: fallbackConversation.id,
          errorMessage: message,
        });
        await handleExecutionFailure({
          job,
          errorMsg: message,
          isOneShot,
        });
        failed = true;
      }
      mark(failed ? "failed" : "completed");
      continue;
    }

    // Reuse the conversation from the last successful run when the flag is set
    // and a prior conversation still exists; otherwise route through the
    // shared `runBackgroundJob` runner (which bootstraps fresh, applies the
    // standard timeout, and emits `activity.failed` on any failure).
    const isRruleSetMsg =
      job.syntax === "rrule" &&
      job.expression != null &&
      hasSetConstructs(job.expression);

    let reusedConversationId: string | null = null;
    if (job.reuseConversation && !isOneShot) {
      const lastId = getLastScheduleConversationId(job.id);
      if (lastId && getConversation(lastId)) {
        reusedConversationId = lastId;
      }
    }

    log.info(
      {
        jobId: job.id,
        name: job.name,
        syntax: job.syntax,
        expression: job.expression,
        isRruleSet: isRruleSetMsg,
        isOneShot,
        ...(reusedConversationId
          ? { conversationId: reusedConversationId }
          : {}),
      },
      isOneShot ? "Executing one-shot schedule" : "Executing schedule",
    );

    let conversationId: string;
    let ok: boolean;
    let errorMsg: string | undefined;
    const conversationReused = reusedConversationId != null;
    let runConversationId = reusedConversationId;
    const runId = await createScheduleRun(job.id, reusedConversationId);

    if (reusedConversationId) {
      // Reuse path: dispatch the message into the existing conversation so it
      // is continued in place. `runBackgroundJob` unconditionally bootstraps a
      // new conversation and is therefore not a drop-in replacement for the
      // reuse semantics.
      conversationId = reusedConversationId;
      broadcastScheduleConversationCreated({
        conversationId,
        scheduleJobId: job.id,
        title: job.name,
      });
      try {
        const { turnFailure } = await dispatchScheduleMessage(
          conversationId,
          job.message,
          {
            trustClass: "guardian",
            cronRunId: runId,
            ...(job.inferenceProfile
              ? { overrideProfile: job.inferenceProfile }
              : {}),
          },
        );
        // A failed LLM call (e.g. an invalid provider) ends the turn without
        // throwing, so treat a reported turn failure as a run error rather
        // than recording "ok".
        if (turnFailure) {
          ok = false;
          errorMsg = describeTurnFailure(turnFailure);
        } else {
          ok = true;
        }
      } catch (err) {
        ok = false;
        errorMsg = err instanceof Error ? err.message : String(err);
      }
    } else {
      // Fresh-bootstrap path: route through the shared runner so failures
      // surface via `activity.failed` and we get the standard timeout +
      // error-classification policy applied to every background producer.
      // The runner fires `onConversationCreated` synchronously after bootstrap
      // (before `processMessage` starts) so the macOS sidebar gets the new
      // conversation immediately rather than after the up-to-30-min job ends.
      const result = await runBackgroundJob({
        jobName: `schedule:${job.id}`,
        source: "schedule",
        prompt: job.message,
        systemHint: `Schedule: ${job.name}`,
        trustContext: { sourceChannel: "vellum", trustClass: "guardian" },
        callSite: "mainAgent",
        cronRunId: runId,
        ...(job.inferenceProfile
          ? { overrideProfile: job.inferenceProfile }
          : {}),
        // Hard timeout for talk-mode scheduled turns: bounds a wedged turn so
        // it cannot block the next scheduler tick. Configurable via
        // timeouts.scheduleTurnTimeoutSec (default 1800s).
        timeoutMs: getConfig().timeouts.scheduleTurnTimeoutSec * 1000,
        origin: "schedule",
        groupId: "system:scheduled",
        conversationType: "scheduled",
        scheduleJobId: job.id,
        suppressFailureNotifications: job.quiet === true,
        onConversationCreated: async (newConversationId) => {
          runConversationId = newConversationId;
          await setScheduleRunConversationId(runId, newConversationId);
          broadcastScheduleConversationCreated({
            conversationId: newConversationId,
            scheduleJobId: job.id,
            title: job.name,
          });
        },
      });
      // Bootstrap-failure path returns `{ ok: false, conversationId: "" }`.
      // Substitute a sentinel only for failures so the schedule-run DB row
      // carries a recognizable marker. Successful skips (e.g.
      // `pre_first_user_message`) also return `conversationId: ""` but with
      // `ok: true` — keep the empty ID to preserve their skip contract.
      conversationId =
        !result.ok && result.conversationId === ""
          ? `bootstrap-error:${job.id}`
          : result.conversationId;
      if (runConversationId !== conversationId) {
        runConversationId = conversationId;
        await setScheduleRunConversationId(runId, conversationId);
      }
      ok = result.ok;
      errorMsg = result.error?.message;
    }

    if (ok) {
      await completeScheduleRun(runId, { status: "ok" });
      if (isOneShot) {
        await completeOneShot(job.id);
      }
      mark("completed");
    } else {
      log.warn(
        {
          err: errorMsg,
          jobId: job.id,
          name: job.name,
          syntax: job.syntax,
          expression: job.expression,
          isRruleSet: isRruleSetMsg,
          isOneShot,
        },
        isOneShot
          ? "One-shot schedule execution failed"
          : "Schedule execution failed",
      );
      await completeScheduleRun(runId, { status: "error", error: errorMsg });
      await handleExecutionFailure({
        job,
        errorMsg: errorMsg ?? "Schedule run failed",
        isOneShot,
      });

      // Only skip invalidation when the conversation was *actually* reused,
      // i.e. it contains prior successful context worth preserving. When
      // reuseConversation is true but no prior conversation existed (first run
      // or deleted), the conversation is brand-new and should be invalidated
      // like any other failed conversation.
      if (!conversationReused) {
        try {
          invalidateAssistantInferredItemsForConversation(conversationId);
        } catch (cleanupErr) {
          log.warn(
            { err: cleanupErr, conversationId },
            "Failed to invalidate assistant-inferred memory items",
          );
        }
      }
      mark("failed");
    }
  }

  return result;
}

function countDueScheduleJobs(now: number): number {
  return listSchedules({ enabledOnly: true }).filter(
    (job) =>
      job.status === "active" &&
      Number.isFinite(job.nextRunAt) &&
      job.nextRunAt > 0 &&
      job.nextRunAt <= now,
  ).length;
}

/**
 * Emit an `activity.failed` notification for a failed scheduled task run.
 * Mirrors the shape `runBackgroundJob` produces for its own failures so the
 * home feed and native notifications stay consistent regardless of which
 * code path executed the work. Fire-and-forget — a notification failure
 * must never break scheduler operation.
 */
function emitTaskActivityFailed(args: {
  taskId: string;
  conversationId: string;
  errorMessage: string;
}): void {
  const day = new Date().toISOString().slice(0, 10);
  emitNotificationSignal({
    sourceChannel: "scheduler",
    sourceContextId: args.conversationId,
    sourceEventName: "activity.failed",
    dedupeKey: `activity-failed:task:${args.taskId}:${day}`,
    contextPayload: {
      jobName: `task:${args.taskId}`,
      errorMessage: args.errorMessage,
      errorKind: "exception",
    },
    attentionHints: {
      requiresAction: false,
      urgency: "medium",
      isAsyncBackground: true,
      visibleInSourceNow: false,
    },
  }).catch((emitErr) => {
    log.warn(
      {
        err: emitErr instanceof Error ? emitErr.message : String(emitErr),
        taskId: args.taskId,
        conversationId: args.conversationId,
      },
      "Failed to emit activity.failed notification for scheduled task",
    );
  });
}

/**
 * Emit an `activity.failed` notification for a schedule whose retries have
 * been exhausted. Distinct from `emitTaskActivityFailed` (which fires per
 * failed task run) — this one fires once when the retry policy has given
 * up, so the dedupeKey caller is the per-attempt key passed in by
 * `applyRetryDecision` (already includes the job id and a timestamp).
 */
function emitScheduleActivityFailed(args: {
  jobId: string;
  jobName: string;
  errorMessage: string;
  dedupKey: string;
}): void {
  emitNotificationSignal({
    sourceChannel: "scheduler",
    sourceContextId: args.jobId,
    sourceEventName: "activity.failed",
    dedupeKey: args.dedupKey,
    contextPayload: {
      jobName: `schedule:${args.jobName}`,
      errorMessage: args.errorMessage,
      errorKind: "exception",
    },
    attentionHints: {
      requiresAction: false,
      urgency: "medium",
      isAsyncBackground: true,
      visibleInSourceNow: false,
    },
  }).catch((emitErr) => {
    log.warn(
      {
        err: emitErr instanceof Error ? emitErr.message : String(emitErr),
        jobId: args.jobId,
      },
      "Failed to emit activity.failed notification for exhausted schedule",
    );
  });
}
