import {
  checkDiskPressureBackgroundGate,
  diskPressureBackgroundSkipLogFields,
  shouldLogDiskPressureBackgroundSkip,
} from "../daemon/disk-pressure-background-gate.js";
import { bootstrapConversation } from "../memory/conversation-bootstrap.js";
import { getConversation } from "../memory/conversation-crud.js";
import { invalidateAssistantInferredItemsForConversation } from "../memory/task-memory-cleanup.js";
import { emitNotificationSignal } from "../notifications/emit-signal.js";
import { wakeAgentForOpportunity } from "../runtime/agent-wake.js";
import { runBackgroundJob } from "../runtime/background-job-runner.js";
import { runSequencesOnce } from "../sequence/engine.js";
import { getLogger } from "../util/logger.js";
import { runWatchersOnce, type WatcherNotifier } from "../watcher/engine.js";
import { hasSetConstructs } from "./recurrence-engine.js";
import { applyRetryDecision, decideRetry } from "./retry-policy.js";
import { runScript, type ScriptResult } from "./run-script.js";
import {
  claimDueSchedules,
  completeOneShot,
  completeScheduleRun,
  createScheduleRun,
  failOneShotPermanently,
  getLastScheduleConversationId,
  listSchedules,
  resetRetryCount,
  retryOneShot,
  type RoutingIntent,
  type ScheduleJob,
  scheduleRetry,
} from "./schedule-store.js";

const log = getLogger("scheduler");

import type { ScheduleMessageProcessor } from "./scheduler-types.js";
type ScheduleNotifyModeNotifier = (payload: {
  id: string;
  label: string;
  message: string;
  routingIntent: RoutingIntent;
  routingHints: Record<string, unknown>;
}) => void | Promise<void>;

type ScheduleConversationCreatedNotifier = (info: {
  conversationId: string;
  scheduleJobId: string;
  title: string;
}) => void;

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
 * Hard timeout for `talk`-mode scheduled jobs. Schedules can do
 * non-trivial work (research, summarize the day, etc.), so the cap is
 * generous; it exists primarily so a wedged turn cannot block the next
 * scheduler tick indefinitely. Mirrors the heartbeat/filing budgets.
 */
const SCHEDULE_TALK_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Apply retry policy on schedule-execution failure. Retries are scheduled by
 * `applyRetryDecision`; once retries are exhausted, the `emitAlert` callback
 * fires an `activity.failed` notification so the user sees that a job
 * permanently failed rather than just silently disappearing.
 */
function handleExecutionFailure(params: {
  job: ScheduleJob;
  errorMsg: string;
  isOneShot: boolean;
}): void {
  const decision = decideRetry(params.job);
  applyRetryDecision({
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

export function startScheduler(
  processMessage: ScheduleMessageProcessor,
  notifyScheduleOneShot: ScheduleNotifyModeNotifier,
  watcherNotifier?: WatcherNotifier,
  onScheduleConversationCreated?: ScheduleConversationCreatedNotifier,
): SchedulerHandle {
  let stopped = false;
  let tickRunning = false;

  const tick = async () => {
    if (stopped || tickRunning) return;
    tickRunning = true;
    try {
      await runScheduleOnce(
        processMessage,
        notifyScheduleOneShot,
        watcherNotifier,
        onScheduleConversationCreated,
      );
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

  return {
    async runOnce(): Promise<number> {
      return runScheduleOnce(
        processMessage,
        notifyScheduleOneShot,
        watcherNotifier,
        onScheduleConversationCreated,
      );
    },
    async runDueWorkOnce(
      options?: SchedulerRunDueWorkOptions,
    ): Promise<SchedulerDueWorkResult> {
      return runScheduleDueWorkOnce(
        processMessage,
        notifyScheduleOneShot,
        watcherNotifier,
        onScheduleConversationCreated,
        options,
      );
    },
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export async function runScheduleOnce(
  processMessage: ScheduleMessageProcessor,
  notifyScheduleOneShot: ScheduleNotifyModeNotifier,
  watcherNotifier?: WatcherNotifier,
  onScheduleConversationCreated?: ScheduleConversationCreatedNotifier,
): Promise<number> {
  const result = await runScheduleDueWorkOnce(
    processMessage,
    notifyScheduleOneShot,
    watcherNotifier,
    onScheduleConversationCreated,
  );
  return result.completed + result.failed + result.skipped;
}

export async function runScheduleDueWorkOnce(
  processMessage: ScheduleMessageProcessor,
  notifyScheduleOneShot: ScheduleNotifyModeNotifier,
  watcherNotifier?: WatcherNotifier,
  onScheduleConversationCreated?: ScheduleConversationCreatedNotifier,
  options: SchedulerRunDueWorkOptions = {},
): Promise<SchedulerDueWorkResult> {
  const now = options.now ?? Date.now();
  const minStartBudgetMs = options.minStartBudgetMs ?? 0;
  const result: SchedulerDueWorkResult = {
    claimed: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    stillPending: 0,
  };
  const mark = (status: "completed" | "failed" | "skipped") => {
    result[status] += 1;
  };

  if (
    options.deadlineAt != null &&
    options.deadlineAt - Date.now() < minStartBudgetMs
  ) {
    result.stillPending = options.includeStillPending
      ? countDueScheduleJobs(now)
      : 0;
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
    result.stillPending = options.includeStillPending
      ? countDueScheduleJobs(now)
      : 0;
    return result;
  }

  // ── Schedules (recurring cron/RRULE + one-shot) ─────────────────────
  const jobs = claimDueSchedules(now);
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
        await notifyScheduleOneShot({
          id: job.id,
          label: job.name,
          message: job.message,
          routingIntent: job.routingIntent,
          routingHints: job.routingHints,
        });
        if (isOneShot) {
          const successRunId = createScheduleRun(job.id, `notify-ok:${job.id}`);
          completeScheduleRun(successRunId, { status: "ok" });
          completeOneShot(job.id);
        } else {
          // Track recurring notify-mode success so lastStatus resets to ok
          // and retryCount clears after a transient failure.
          const runId = createScheduleRun(job.id, `notify-ok:${job.id}`);
          completeScheduleRun(runId, { status: "ok" });
        }
      } catch (err) {
        log.warn(
          { err, jobId: job.id, name: job.name, isOneShot },
          "Schedule notification failed",
        );
        const errorMsg = err instanceof Error ? err.message : String(err);
        const errorRunId = createScheduleRun(job.id, `notify-error:${job.id}`);
        completeScheduleRun(errorRunId, { status: "error", error: errorMsg });
        handleExecutionFailure({ job, errorMsg, isOneShot });
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
      const runId = createScheduleRun(job.id, `script:${job.id}`);
      let failed = false;
      try {
        log.info(
          { jobId: job.id, name: job.name, isOneShot },
          "Executing script schedule",
        );
        const result: ScriptResult = await runScript(job.script);
        completeScheduleRun(runId, {
          status: result.exitCode === 0 ? "ok" : "error",
          output: result.stdout || undefined,
          error: result.stderr || undefined,
        });
        if (result.exitCode === 0) {
          if (isOneShot) completeOneShot(job.id);
        } else {
          const errorMsg =
            result.stderr || "Script exited with non-zero status";
          handleExecutionFailure({ job, errorMsg, isOneShot });
          failed = true;
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        log.warn(
          { err, jobId: job.id, name: job.name, isOneShot },
          "Script schedule execution failed",
        );
        completeScheduleRun(runId, { status: "error", error: errorMsg });
        handleExecutionFailure({ job, errorMsg, isOneShot });
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
        if (isOneShot) completeOneShot(job.id);
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
            failOneShotPermanently(job.id);
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
            retryOneShot(job.id);
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
          if (isOneShot) completeOneShot(job.id);
          mark("skipped");
          continue;
        }

        if (isOneShot) {
          const successRunId = createScheduleRun(job.id, `wake-ok:${job.id}`);
          completeScheduleRun(successRunId, { status: "ok" });
          completeOneShot(job.id);
        }
      } catch (err) {
        log.warn(
          { err, jobId: job.id, name: job.name, wakeConversationId, isOneShot },
          "Wake schedule execution failed",
        );
        const errorMsg = err instanceof Error ? err.message : String(err);
        const wakeErrorRunId = createScheduleRun(
          job.id,
          `wake-error:${job.id}`,
        );
        completeScheduleRun(wakeErrorRunId, {
          status: "error",
          error: errorMsg,
        });
        handleExecutionFailure({ job, errorMsg, isOneShot });
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
            await processMessage(conversationId, message, {
              trustClass: "guardian",
              taskRunId,
            });
          },
        );

        onScheduleConversationCreated?.({
          conversationId: result.conversationId,
          scheduleJobId: job.id,
          title: result.status === "failed" ? `${job.name}: Error` : job.name,
        });

        // Track the schedule run using the task's conversation
        const runId = createScheduleRun(job.id, result.conversationId);
        if (result.status === "failed") {
          const errorMessage = result.error ?? "Task run failed";
          completeScheduleRun(runId, {
            status: "error",
            error: errorMessage,
          });
          emitTaskActivityFailed({
            taskId,
            conversationId: result.conversationId,
            errorMessage,
          });
          handleExecutionFailure({
            job,
            errorMsg: errorMessage,
            isOneShot,
          });
          failed = true;
        } else {
          completeScheduleRun(runId, { status: "ok" });
          if (isOneShot) completeOneShot(job.id);
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
        const fallbackConversation = bootstrapConversation({
          conversationType: "scheduled",
          source: "schedule",
          scheduleJobId: job.id,
          groupId: "system:scheduled",
          origin: "schedule",
          systemHint: `Schedule: ${job.name}`,
        });
        onScheduleConversationCreated?.({
          conversationId: fallbackConversation.id,
          scheduleJobId: job.id,
          title: `${job.name}: Error`,
        });
        const runId = createScheduleRun(job.id, fallbackConversation.id);
        completeScheduleRun(runId, { status: "error", error: message });
        emitTaskActivityFailed({
          taskId,
          conversationId: fallbackConversation.id,
          errorMessage: message,
        });
        handleExecutionFailure({
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

    if (reusedConversationId) {
      // Reuse path: keep using the injected `processMessage` callback so the
      // existing conversation is continued in place. `runBackgroundJob`
      // unconditionally bootstraps a new conversation and is therefore not a
      // drop-in replacement for the reuse semantics.
      conversationId = reusedConversationId;
      onScheduleConversationCreated?.({
        conversationId,
        scheduleJobId: job.id,
        title: job.name,
      });
      try {
        await processMessage(conversationId, job.message, {
          trustClass: "guardian",
        });
        ok = true;
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
        trustContext: { sourceChannel: "vellum", trustClass: "guardian" },
        callSite: "mainAgent",
        timeoutMs: SCHEDULE_TALK_TIMEOUT_MS,
        origin: "schedule",
        groupId: "system:scheduled",
        conversationType: "scheduled",
        scheduleJobId: job.id,
        suppressFailureNotifications: job.quiet === true,
        onConversationCreated: (newConversationId) => {
          onScheduleConversationCreated?.({
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
      ok = result.ok;
      errorMsg = result.error?.message;
    }

    const runId = createScheduleRun(job.id, conversationId);

    if (ok) {
      completeScheduleRun(runId, { status: "ok" });
      if (isOneShot) completeOneShot(job.id);
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
      completeScheduleRun(runId, { status: "error", error: errorMsg });
      handleExecutionFailure({
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

  // ── Watchers (event-driven polling) ────────────────────────────────
  if (watcherNotifier) {
    try {
      const watcherProcessed = await runWatchersOnce(watcherNotifier);
      result.completed += watcherProcessed;
    } catch (err) {
      log.error({ err }, "Watcher tick failed");
    }
  }

  // ── Sequences (multi-step outreach) ──────────────────────────────
  try {
    const sequenceProcessed = await runSequencesOnce();
    result.completed += sequenceProcessed;
  } catch (err) {
    log.error({ err }, "Sequence engine tick failed");
  }

  if (options.includeStillPending) {
    result.stillPending = countDueScheduleJobs(Date.now());
  }
  const processed = result.completed + result.failed + result.skipped;
  if (processed > 0) {
    log.info({ processed }, "Schedule tick complete");
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
