import { getLogger } from '../util/logger.js';
import { createConversation } from '../memory/conversation-store.js';
import {
  claimDueSchedules,
  createScheduleRun,
  completeScheduleRun,
} from './schedule-store.js';
import { claimDueReminders, completeReminder, failReminder, setReminderConversationId } from '../tools/reminder/reminder-store.js';

const log = getLogger('scheduler');

export type ScheduleMessageProcessor = (
  conversationId: string,
  message: string,
) => Promise<unknown>;

export type ReminderNotifier = (reminder: { id: string; label: string; message: string }) => void;

export type ScheduleNotifier = (schedule: { id: string; name: string }) => void;

export interface SchedulerHandle {
  runOnce(): Promise<number>;
  stop(): void;
}

const TICK_INTERVAL_MS = 15_000;

export function startScheduler(
  processMessage: ScheduleMessageProcessor,
  notifyReminder: ReminderNotifier,
  notifySchedule: ScheduleNotifier,
): SchedulerHandle {
  let stopped = false;
  let tickRunning = false;

  const tick = async () => {
    if (stopped || tickRunning) return;
    tickRunning = true;
    try {
      await runScheduleOnce(processMessage, notifyReminder, notifySchedule);
    } catch (err) {
      log.error({ err }, 'Schedule tick failed');
    } finally {
      tickRunning = false;
    }
  };

  const timer = setInterval(() => { void tick(); }, TICK_INTERVAL_MS);
  timer.unref();
  void tick();

  return {
    async runOnce(): Promise<number> {
      return runScheduleOnce(processMessage, notifyReminder);
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
): Promise<number> {
  const now = Date.now();
  let processed = 0;

  // ── Cron jobs ───────────────────────────────────────────────────────
  const jobs = claimDueSchedules(now);
  for (const job of jobs) {
    const conversation = createConversation(`Schedule: ${job.name}`);
    const runId = createScheduleRun(job.id, conversation.id);

    try {
      log.info({ jobId: job.id, name: job.name, conversationId: conversation.id }, 'Executing schedule');
      await processMessage(conversation.id, job.message);
      completeScheduleRun(runId, { status: 'ok' });
      notifySchedule({ id: job.id, name: job.name });
      processed += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err, jobId: job.id, name: job.name }, 'Schedule execution failed');
      completeScheduleRun(runId, { status: 'error', error: message });
    }
  }

  // ── One-shot reminders ──────────────────────────────────────────────
  const dueReminders = claimDueReminders(now);
  for (const reminder of dueReminders) {
    if (reminder.mode === 'execute') {
      const conversation = createConversation(`Reminder: ${reminder.label}`);
      setReminderConversationId(reminder.id, conversation.id);
      try {
        log.info({ reminderId: reminder.id, label: reminder.label, conversationId: conversation.id }, 'Executing reminder');
        await processMessage(conversation.id, reminder.message);
        completeReminder(reminder.id);
      } catch (err) {
        log.warn({ err, reminderId: reminder.id }, 'Reminder execution failed, reverting to pending');
        failReminder(reminder.id);
      }
    } else {
      try {
        log.info({ reminderId: reminder.id, label: reminder.label }, 'Firing reminder notification');
        notifyReminder({ id: reminder.id, label: reminder.label, message: reminder.message });
        completeReminder(reminder.id);
      } catch (err) {
        log.warn({ err, reminderId: reminder.id }, 'Reminder notification failed, reverting to pending');
        failReminder(reminder.id);
      }
    }
    processed += 1;
  }

  if (processed > 0) {
    log.info({ processed }, 'Schedule tick complete');
  }
  return processed;
}
