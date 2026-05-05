import {
  checkDiskPressureBackgroundGate,
  diskPressureBackgroundSkipLogFields,
  shouldLogDiskPressureBackgroundSkip,
} from "../daemon/disk-pressure-background-gate.js";
import { emitFeedEvent } from "../home/emit-feed-event.js";
import { bootstrapConversation } from "../memory/conversation-bootstrap.js";
import { getConversation } from "../memory/conversation-crud.js";
import { invalidateAssistantInferredItemsForConversation } from "../memory/task-memory-cleanup.js";
import { wakeAgentForOpportunity } from "../runtime/agent-wake.js";
import { runSequencesOnce } from "../sequence/engine.js";
import { getLogger } from "../util/logger.js";
import {
  runWatchersOnce,
  type WatcherEscalator,
  type WatcherNotifier,
} from "../watcher/engine.js";
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
  stop(): void;
}

const TICK_INTERVAL_MS = 15_000;

/**
 * Maximum number of times a wake can be retried after a timeout before
 * being permanently failed. At 15-second scheduler intervals, 20 retries
 * ≈ 5 minutes of total retry window.
 */
const WAKE_MAX_RETRIES = 20;

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
    emitAlert: (title, summary, dedupKey) =>
      emitScheduleFeedEvent({ title, summary, dedupKey }),
    log,
  });
}

export function startScheduler(
  processMessage: ScheduleMessageProcessor,
  notifyScheduleOneShot: ScheduleNotifyModeNotifier,
  watcherNotifier?: WatcherNotifier,
  watcherEscalator?: WatcherEscalator,
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
        watcherEscalator,
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
        watcherEscalator,
        onScheduleConversationCreated,
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
  watcherEscalator?: WatcherEscalator,
  onScheduleConversationCreated?: ScheduleConversationCreatedNotifier,
): Promise<number> {
  const now = Date.now();
  let processed = 0;

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
    return 0;
  }

  // ── Schedules (recurring cron/RRULE + one-shot) ─────────────────────
  const jobs = claimDueSchedules(now);
  for (const job of jobs) {
    const isOneShot = job.expression == null;

    // ── Notify mode (one-shot or recurring) ─────────────────────────
    if (job.mode === "notify") {
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
          emitScheduleFeedEvent({
            title: job.name,
            summary: "Reminder fired.",
            dedupKey: `schedule-notify-oneshot:${job.id}`,
          });
        } else {
          // Track recurring notify-mode success so lastStatus resets to ok
          // and retryCount clears after a transient failure.
          const runId = createScheduleRun(job.id, `notify-ok:${job.id}`);
          completeScheduleRun(runId, { status: "ok" });
          emitScheduleFeedEvent({
            title: job.name,
            summary: "Scheduled notification fired.",
            dedupKey: `schedule-run:${runId}`,
          });
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
      }
      processed += 1;
      continue;
    }

    // ── Script mode (shell command, no LLM) ────────────────────────
    if (job.mode === "script") {
      if (!job.script) {
        log.warn(
          { jobId: job.id, name: job.name },
          "Script schedule has no script command — skipping",
        );
        processed += 1;
        continue;
      }
      const runId = createScheduleRun(job.id, `script:${job.id}`);
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
          if (!job.quiet) {
            emitScheduleFeedEvent({
              title: job.name,
              summary: "Script ran.",
              dedupKey: `schedule-run:${runId}`,
            });
          }
          if (isOneShot) completeOneShot(job.id);
        } else {
          const errorMsg =
            result.stderr || "Script exited with non-zero status";
          handleExecutionFailure({ job, errorMsg, isOneShot });
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        log.warn(
          { err, jobId: job.id, name: job.name, isOneShot },
          "Script schedule execution failed",
        );
        completeScheduleRun(runId, { status: "error", error: errorMsg });
        handleExecutionFailure({ job, errorMsg, isOneShot });
      }
      processed += 1;
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
        processed += 1;
        continue;
      }

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
          processed += 1;
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
          processed += 1;
          continue;
        }

        if (isOneShot) {
          const successRunId = createScheduleRun(job.id, `wake-ok:${job.id}`);
          completeScheduleRun(successRunId, { status: "ok" });
          completeOneShot(job.id);
        }
        if (!job.quiet) {
          emitScheduleFeedEvent({
            title: job.name,
            summary: "Deferred wake fired.",
            dedupKey: `schedule-wake:${job.id}`,
          });
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
      }
      processed += 1;
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
          completeScheduleRun(runId, {
            status: "error",
            error: result.error ?? "Task run failed",
          });
          handleExecutionFailure({
            job,
            errorMsg: result.error ?? "Task run failed",
            isOneShot,
          });
        } else {
          completeScheduleRun(runId, { status: "ok" });
          if (!job.quiet) {
            emitScheduleFeedEvent({
              title: job.name,
              summary: "Scheduled task ran.",
              dedupKey: `schedule-run:${runId}`,
            });
          }
          if (isOneShot) completeOneShot(job.id);
        }
        processed += 1;
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
        handleExecutionFailure({
          job,
          errorMsg: message,
          isOneShot,
        });
      }
      continue;
    }

    // Reuse the conversation from the last successful run when the flag is set
    // and a prior conversation still exists; otherwise bootstrap a new one.
    let conversationId: string | null = null;
    let conversationReused = false;
    if (job.reuseConversation && !isOneShot) {
      const lastId = getLastScheduleConversationId(job.id);
      if (lastId && getConversation(lastId)) {
        conversationId = lastId;
        conversationReused = true;
      }
    }
    if (!conversationId) {
      const conversation = bootstrapConversation({
        conversationType: "scheduled",
        source: "schedule",
        scheduleJobId: job.id,
        groupId: "system:scheduled",
        origin: "schedule",
        systemHint: isOneShot
          ? `Reminder: ${job.name}`
          : `Schedule: ${job.name}`,
      });
      conversationId = conversation.id;
    }
    onScheduleConversationCreated?.({
      conversationId,
      scheduleJobId: job.id,
      title: job.name,
    });
    const runId = createScheduleRun(job.id, conversationId);
    const isRruleSetMsg =
      job.syntax === "rrule" &&
      job.expression != null &&
      hasSetConstructs(job.expression);

    try {
      log.info(
        {
          jobId: job.id,
          name: job.name,
          syntax: job.syntax,
          expression: job.expression,
          isRruleSet: isRruleSetMsg,
          isOneShot,
          conversationId,
        },
        isOneShot ? "Executing one-shot schedule" : "Executing schedule",
      );
      await processMessage(conversationId, job.message, {
        trustClass: "guardian",
      });
      completeScheduleRun(runId, { status: "ok" });
      if (!job.quiet) {
        emitScheduleFeedEvent({
          title: job.name,
          summary: isOneShot ? "One-shot reminder ran." : "Scheduled job ran.",
          dedupKey: `schedule-run:${runId}`,
        });
      }
      if (isOneShot) completeOneShot(job.id);
      processed += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(
        {
          err,
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
      completeScheduleRun(runId, { status: "error", error: message });
      handleExecutionFailure({ job, errorMsg: message, isOneShot });

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
    }
  }

  // ── Watchers (event-driven polling) ────────────────────────────────
  if (watcherNotifier && watcherEscalator) {
    try {
      const watcherProcessed = await runWatchersOnce(
        processMessage,
        watcherNotifier,
        watcherEscalator,
      );
      processed += watcherProcessed;
    } catch (err) {
      log.error({ err }, "Watcher tick failed");
    }
  }

  // ── Sequences (multi-step outreach) ──────────────────────────────
  try {
    const sequenceProcessed = await runSequencesOnce(processMessage);
    processed += sequenceProcessed;
  } catch (err) {
    log.error({ err }, "Sequence engine tick failed");
  }

  if (processed > 0) {
    log.info({ processed }, "Schedule tick complete");
  }
  return processed;
}

/**
 * Fire-and-forget home-feed emit for a successful schedule run.
 *
 * Wraps {@link emitFeedEvent} with local error handling so a schema
 * failure or writer hiccup can never interrupt the scheduler tick
 * loop. The dedupKey is always derived from the schedule run id (or
 * the job id, for one-shot notify-mode which fires before a run
 * record is created) so each run lands as its own entry in the
 * activity log — the writer's per-source cap keeps total volume
 * bounded.
 */
function emitScheduleFeedEvent(params: {
  title: string;
  summary: string;
  dedupKey: string;
}): void {
  void emitFeedEvent({
    source: "assistant",
    title: params.title,
    summary: params.summary,
    dedupKey: params.dedupKey,
  }).catch((err) => {
    log.warn(
      { err, dedupKey: params.dedupKey },
      "Failed to emit schedule feed event",
    );
  });
}
