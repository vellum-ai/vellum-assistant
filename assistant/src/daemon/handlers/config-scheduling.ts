import * as net from 'node:net';
import { listSchedules, updateSchedule, deleteSchedule, describeCronExpression, getSchedule, createScheduleRun, completeScheduleRun } from '../../schedule/schedule-store.js';
import { createConversation } from '../../memory/conversation-store.js';
import { listReminders, cancelReminder } from '../../tools/reminder/reminder-store.js';
import type {
  ScheduleToggle,
  ScheduleRemove,
  ScheduleRunNow,
  ReminderCancel,
} from '../ipc-protocol.js';
import { log, defineHandlers, type HandlerContext } from './shared.js';

export function handleSchedulesList(socket: net.Socket, ctx: HandlerContext): void {
  const jobs = listSchedules();
  ctx.send(socket, {
    type: 'schedules_list_response',
    schedules: jobs.map((j) => ({
      id: j.id,
      name: j.name,
      enabled: j.enabled,
      syntax: j.syntax,
      expression: j.expression,
      cronExpression: j.cronExpression,
      timezone: j.timezone,
      message: j.message,
      nextRunAt: j.nextRunAt,
      lastRunAt: j.lastRunAt,
      lastStatus: j.lastStatus,
      description: j.syntax === 'cron' ? describeCronExpression(j.cronExpression) : j.expression,
    })),
  });
}

export function handleScheduleToggle(
  msg: ScheduleToggle,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    updateSchedule(msg.id, { enabled: msg.enabled });
    log.info({ id: msg.id, enabled: msg.enabled }, 'Schedule toggled via client');
  } catch (err) {
    log.error({ err }, 'Failed to toggle schedule');
  }
  handleSchedulesList(socket, ctx);
}

export function handleScheduleRemove(
  msg: ScheduleRemove,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    const removed = deleteSchedule(msg.id);
    if (!removed) {
      log.warn({ id: msg.id }, 'Schedule not found for removal');
    } else {
      log.info({ id: msg.id }, 'Schedule removed via client');
    }
  } catch (err) {
    log.error({ err }, 'Failed to remove schedule');
  }
  handleSchedulesList(socket, ctx);
}

export async function handleScheduleRunNow(
  msg: ScheduleRunNow,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  const schedule = getSchedule(msg.id);
  if (!schedule) {
    log.warn({ id: msg.id }, 'Schedule not found for run-now');
    return;
  }

  // Check if message is a task invocation (run_task:<task_id>)
  const taskMatch = schedule.message.match(/^run_task:(\S+)$/);
  if (taskMatch) {
    const taskId = taskMatch[1];
    try {
      log.info({ jobId: schedule.id, name: schedule.name, taskId }, 'Executing scheduled task manually (run now)');
      const { runTask } = await import('../../tasks/task-runner.js');
      const result = await runTask(
        { taskId, workingDir: process.cwd() },
        async (conversationId, message, taskRunId) => {
          const session = await ctx.getOrCreateSession(conversationId, socket, true);
          (session as unknown as { taskRunId?: string }).taskRunId = taskRunId;
          await session.processMessage(message, [], (event) => {
            ctx.send(socket, event);
          });
        },
      );

      const runId = createScheduleRun(schedule.id, result.conversationId);
      if (result.status === 'failed') {
        completeScheduleRun(runId, { status: 'error', error: result.error ?? 'Task run failed' });
      } else {
        completeScheduleRun(runId, { status: 'ok' });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err, jobId: schedule.id, name: schedule.name, taskId }, 'Manual scheduled task execution failed');
      const fallbackConversation = createConversation({ title: `Schedule (manual): ${schedule.name}`, source: 'schedule' });
      const runId = createScheduleRun(schedule.id, fallbackConversation.id);
      completeScheduleRun(runId, { status: 'error', error: message });
    }
    handleSchedulesList(socket, ctx);
    return;
  }

  const conversation = createConversation({ title: `Schedule (manual): ${schedule.name}`, source: 'schedule' });
  const runId = createScheduleRun(schedule.id, conversation.id);

  try {
    log.info({ jobId: schedule.id, name: schedule.name, conversationId: conversation.id }, 'Executing schedule manually (run now)');
    const session = await ctx.getOrCreateSession(conversation.id, socket, true);
    await session.processMessage(schedule.message, [], (event) => {
      ctx.send(socket, event);
    });
    completeScheduleRun(runId, { status: 'ok' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err, jobId: schedule.id, name: schedule.name }, 'Manual schedule execution failed');
    completeScheduleRun(runId, { status: 'error', error: message });
  }
  handleSchedulesList(socket, ctx);
}

export function handleRemindersList(socket: net.Socket, ctx: HandlerContext): void {
  const items = listReminders();
  ctx.send(socket, {
    type: 'reminders_list_response',
    reminders: items.map((r) => ({
      id: r.id,
      label: r.label,
      message: r.message,
      fireAt: r.fireAt,
      mode: r.mode,
      status: r.status,
      firedAt: r.firedAt,
      createdAt: r.createdAt,
    })),
  });
}

export function handleReminderCancel(
  msg: ReminderCancel,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    const cancelled = cancelReminder(msg.id);
    if (!cancelled) {
      log.warn({ id: msg.id }, 'Reminder not found or already fired/cancelled');
    } else {
      log.info({ id: msg.id }, 'Reminder cancelled via client');
    }
  } catch (err) {
    log.error({ err }, 'Failed to cancel reminder');
  }
  handleRemindersList(socket, ctx);
}

export const schedulingHandlers = defineHandlers({
  schedules_list: (_msg, socket, ctx) => handleSchedulesList(socket, ctx),
  schedule_toggle: handleScheduleToggle,
  schedule_remove: handleScheduleRemove,
  schedule_run_now: handleScheduleRunNow,
  reminders_list: (_msg, socket, ctx) => handleRemindersList(socket, ctx),
  reminder_cancel: handleReminderCancel,
});
