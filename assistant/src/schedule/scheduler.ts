import { bootstrapConversation } from "../memory/conversation-bootstrap.js";
import { invalidateAssistantInferredItemsForConversation } from "../memory/task-memory-cleanup.js";
import { runSequencesOnce } from "../sequence/engine.js";
import {
  claimDueReminders,
  completeReminder,
  failReminder,
  type RoutingIntent,
  setReminderConversationId,
} from "../tools/reminder/reminder-store.js";
import { getLogger } from "../util/logger.js";
import {
  runWatchersOnce,
  type WatcherEscalator,
  type WatcherNotifier,
} from "../watcher/engine.js";
import { hasSetConstructs } from "./recurrence-engine.js";
import {
  claimDueSchedules,
  completeScheduleRun,
  createScheduleRun,
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

export type ReminderNotifier = (reminder: {
  id: string;
  label: string;
  message: string;
  routingIntent: RoutingIntent;
  routingHints: Record<string, unknown>;
}) => void;

export type ScheduleNotifier = (schedule: { id: string; name: string }) => void;

export type ScheduleThreadCreatedNotifier = (info: {
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
  notifyReminder: ReminderNotifier,
  notifySchedule: ScheduleNotifier,
  watcherNotifier?: WatcherNotifier,
  watcherEscalator?: WatcherEscalator,
  onScheduleThreadCreated?: ScheduleThreadCreatedNotifier,
): SchedulerHandle {
  let stopped = false;
  let tickRunning = false;

  const tick = async () => {
    if (stopped || tickRunning) return;
    tickRunning = true;
    try {
      await runScheduleOnce(
        processMessage,
        notifyReminder,
        notifySchedule,
        watcherNotifier,
        watcherEscalator,
        onScheduleThreadCreated,
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
        notifyReminder,
        notifySchedule,
        watcherNotifier,
        watcherEscalator,
        onScheduleThreadCreated,
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
  notifyReminder: ReminderNotifier,
  notifySchedule: ScheduleNotifier,
  watcherNotifier?: WatcherNotifier,
  watcherEscalator?: WatcherEscalator,
  onScheduleThreadCreated?: ScheduleThreadCreatedNotifier,
): Promise<number> {
  const now = Date.now();
  let processed = 0;

  // ── Recurrence schedules (cron + RRULE) ─────────────────────────────
  const jobs = claimDueSchedules(now);
  for (const job of jobs) {
    // Check if message is a task invocation (run_task:<task_id>)
    const taskMatch = job.message.match(/^run_task:(\S+)$/);
    if (taskMatch) {
      const taskId = taskMatch[1];
      const isRruleSet =
        job.syntax === "rrule" && job.expression != null && hasSetConstructs(job.expression);
      try {
        log.info(
          {
            jobId: job.id,
            name: job.name,
            taskId,
            syntax: job.syntax,
            expression: job.expression,
            isRruleSet,
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
        } else {
          completeScheduleRun(runId, { status: "ok" });
          notifySchedule({ id: job.id, name: job.name });
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
        onScheduleThreadCreated?.({
          conversationId: fallbackConversation.id,
          scheduleJobId: job.id,
          title: `${job.name}: Error`,
        });
        const runId = createScheduleRun(job.id, fallbackConversation.id);
        completeScheduleRun(runId, { status: "error", error: message });
      }
      continue;
    }

    const conversation = bootstrapConversation({
      source: "schedule",
      scheduleJobId: job.id,
      origin: "schedule",
      systemHint: `Schedule: ${job.name}`,
    });
    onScheduleThreadCreated?.({
      conversationId: conversation.id,
      scheduleJobId: job.id,
      title: job.name,
    });
    const runId = createScheduleRun(job.id, conversation.id);
    const isRruleSetMsg =
      job.syntax === "rrule" && job.expression != null && hasSetConstructs(job.expression);

    try {
      log.info(
        {
          jobId: job.id,
          name: job.name,
          syntax: job.syntax,
          expression: job.expression,
          isRruleSet: isRruleSetMsg,
          conversationId: conversation.id,
        },
        "Executing schedule",
      );
      await processMessage(conversation.id, job.message, {
        trustClass: "guardian",
      });
      completeScheduleRun(runId, { status: "ok" });
      notifySchedule({ id: job.id, name: job.name });
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
        },
        "Schedule execution failed",
      );
      completeScheduleRun(runId, { status: "error", error: message });

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

  // ── One-shot reminders ──────────────────────────────────────────────
  const dueReminders = claimDueReminders(now);
  for (const reminder of dueReminders) {
    if (reminder.mode === "execute") {
      const conversation = bootstrapConversation({
        source: "reminder",
        origin: "reminder",
        systemHint: `Reminder: ${reminder.label}`,
      });
      setReminderConversationId(reminder.id, conversation.id);
      try {
        log.info(
          {
            reminderId: reminder.id,
            label: reminder.label,
            conversationId: conversation.id,
          },
          "Executing reminder",
        );
        await processMessage(conversation.id, reminder.message, {
          trustClass: "guardian",
        });
        completeReminder(reminder.id);
      } catch (err) {
        log.warn(
          { err, reminderId: reminder.id },
          "Reminder execution failed, reverting to pending",
        );
        failReminder(reminder.id);
      }
    } else {
      try {
        log.info(
          { reminderId: reminder.id, label: reminder.label },
          "Firing reminder notification",
        );
        notifyReminder({
          id: reminder.id,
          label: reminder.label,
          message: reminder.message,
          routingIntent: reminder.routingIntent,
          routingHints: reminder.routingHints,
        });
        completeReminder(reminder.id);
      } catch (err) {
        log.warn(
          { err, reminderId: reminder.id },
          "Reminder notification failed, reverting to pending",
        );
        failReminder(reminder.id);
      }
    }
    processed += 1;
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
