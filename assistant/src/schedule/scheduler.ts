import type { LLMCallSite } from "../config/schemas/llm.js";
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
import { runScript, type ScriptResult } from "./run-script.js";
import {
  claimDueSchedules,
  completeOneShot,
  completeScheduleRun,
  createScheduleRun,
  failOneShot,
  failOneShotPermanently,
  getLastScheduleConversationId,
  retryOneShot,
  type RoutingIntent,
} from "./schedule-store.js";

const log = getLogger("scheduler");

export interface ScheduleMessageOptions {
  trustClass?: "guardian" | "trusted_contact" | "unknown";
  taskRunId?: string;
  /**
   * Optional LLM call-site identifier propagated to the per-call provider
   * config. Schedule and sequence callers will start passing their own call-site
   * (e.g. for a future scheduled-agent profile) once PRs 7-11 migrate them off
   * the default `mainAgent` route.
   */
  callSite?: LLMCallSite;
}

export type ScheduleMessageProcessor = (
  conversationId: string,
  message: string,
  options?: ScheduleMessageOptions,
) => Promise<unknown>;

export type ScheduleNotifyModeNotifier = (payload: {
  id: string;
  label: string;
  message: string;
  routingIntent: RoutingIntent;
  routingHints: Record<string, unknown>;
}) => void | Promise<void>;

export type ScheduleConversationCreatedNotifier = (info: {
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

/**
 * Hard timeout for `talk`-mode scheduled jobs. Schedules can do
 * non-trivial work (research, summarize the day, etc.), so the cap is
 * generous; it exists primarily so a wedged turn cannot block the next
 * scheduler tick indefinitely. Mirrors the heartbeat/filing budgets.
 */
const SCHEDULE_TALK_TIMEOUT_MS = 30 * 60 * 1000;

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
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}

async function runScheduleOnce(
  processMessage: ScheduleMessageProcessor,
  notifyScheduleOneShot: ScheduleNotifyModeNotifier,
  watcherNotifier?: WatcherNotifier,
  onScheduleConversationCreated?: ScheduleConversationCreatedNotifier,
): Promise<number> {
  const now = Date.now();
  let processed = 0;

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
        if (isOneShot) {
          failOneShot(job.id);
        } else {
          // Track recurring notify-mode failures via a schedule run so the
          // occurrence isn't silently lost and lastStatus/retryCount update.
          const errorMsg = err instanceof Error ? err.message : String(err);
          const runId = createScheduleRun(job.id, `notify-error:${job.id}`);
          completeScheduleRun(runId, { status: "error", error: errorMsg });
        }
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
          if (isOneShot) completeOneShot(job.id);
        } else {
          if (isOneShot) failOneShot(job.id);
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        log.warn(
          { err, jobId: job.id, name: job.name, isOneShot },
          "Script schedule execution failed",
        );
        completeScheduleRun(runId, { status: "error", error: errorMsg });
        if (isOneShot) failOneShot(job.id);
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

        if (isOneShot) completeOneShot(job.id);
      } catch (err) {
        log.warn(
          { err, jobId: job.id, name: job.name, wakeConversationId, isOneShot },
          "Wake schedule execution failed",
        );
        if (isOneShot) failOneShot(job.id);
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
          const errorMessage = result.error ?? "Task run failed";
          completeScheduleRun(runId, {
            status: "error",
            error: errorMessage,
          });
          if (isOneShot) failOneShot(job.id);
          emitTaskActivityFailed({
            taskId,
            conversationId: result.conversationId,
            errorMessage,
          });
        } else {
          completeScheduleRun(runId, { status: "ok" });
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
        if (isOneShot) failOneShot(job.id);
        emitTaskActivityFailed({
          taskId,
          conversationId: fallbackConversation.id,
          errorMessage: message,
        });
      }
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
      conversationId = result.conversationId;
      ok = result.ok;
      errorMsg = result.error?.message;
    }

    const runId = createScheduleRun(job.id, conversationId);

    if (ok) {
      completeScheduleRun(runId, { status: "ok" });
      if (isOneShot) completeOneShot(job.id);
      processed += 1;
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
      if (isOneShot) failOneShot(job.id);

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
  if (watcherNotifier) {
    try {
      const watcherProcessed = await runWatchersOnce(watcherNotifier);
      processed += watcherProcessed;
    } catch (err) {
      log.error({ err }, "Watcher tick failed");
    }
  }

  // ── Sequences (multi-step outreach) ──────────────────────────────
  try {
    const sequenceProcessed = await runSequencesOnce();
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
