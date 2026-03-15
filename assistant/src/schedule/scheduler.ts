import { bootstrapConversation } from "../memory/conversation-bootstrap.js";
import { invalidateAssistantInferredItemsForConversation } from "../memory/task-memory-cleanup.js";
import { runSequencesOnce } from "../sequence/engine.js";
import { getLogger } from "../util/logger.js";
import {
  runWatchersOnce,
  type WatcherEscalator,
  type WatcherNotifier,
} from "../watcher/engine.js";
import { hasSetConstructs } from "./recurrence-engine.js";
import {
  claimDueSchedules,
  completeOneShot,
  completeScheduleRun,
  createScheduleRun,
  failOneShot,
  type RoutingIntent,
} from "./schedule-store.js";

const log = getLogger("scheduler");

export interface ScheduleMessageOptions {
  trustClass?: "guardian" | "trusted_contact" | "unknown";
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

export type ScheduleNotifier = (schedule: { id: string; name: string }) => void;

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

export function startScheduler(
  processMessage: ScheduleMessageProcessor,
  notifyScheduleOneShot: ScheduleNotifyModeNotifier,
  notifySchedule: ScheduleNotifier,
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
        notifySchedule,
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
        notifySchedule,
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

async function runScheduleOnce(
  processMessage: ScheduleMessageProcessor,
  notifyScheduleOneShot: ScheduleNotifyModeNotifier,
  notifySchedule: ScheduleNotifier,
  watcherNotifier?: WatcherNotifier,
  watcherEscalator?: WatcherEscalator,
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
          { taskId, workingDir: process.cwd(), source: "schedule" },
          processMessage as (
            conversationId: string,
            message: string,
            taskRunId: string,
          ) => Promise<void>,
        );

        // Track the schedule run using the task's conversation
        const runId = createScheduleRun(job.id, result.conversationId);
        if (result.status === "failed") {
          completeScheduleRun(runId, {
            status: "error",
            error: result.error ?? "Task run failed",
          });
          if (isOneShot) failOneShot(job.id);
        } else {
          completeScheduleRun(runId, { status: "ok" });
          notifySchedule({ id: job.id, name: job.name });
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
          source: "schedule",
          scheduleJobId: job.id,
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
      }
      continue;
    }

    const conversation = bootstrapConversation({
      source: "schedule",
      scheduleJobId: job.id,
      origin: "schedule",
      systemHint: isOneShot ? `Reminder: ${job.name}` : `Schedule: ${job.name}`,
    });
    onScheduleConversationCreated?.({
      conversationId: conversation.id,
      scheduleJobId: job.id,
      title: job.name,
    });
    const runId = createScheduleRun(job.id, conversation.id);
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
          conversationId: conversation.id,
        },
        isOneShot ? "Executing one-shot schedule" : "Executing schedule",
      );
      await processMessage(conversation.id, job.message, {
        trustClass: "guardian",
      });
      completeScheduleRun(runId, { status: "ok" });
      notifySchedule({ id: job.id, name: job.name });
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
      if (isOneShot) failOneShot(job.id);

      try {
        invalidateAssistantInferredItemsForConversation(conversation.id);
      } catch (cleanupErr) {
        log.warn(
          { err: cleanupErr, conversationId: conversation.id },
          "Failed to invalidate assistant-inferred memory items",
        );
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
