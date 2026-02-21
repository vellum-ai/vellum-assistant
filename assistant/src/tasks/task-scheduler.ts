import { createSchedule } from '../schedule/schedule-store.js';

/**
 * Create a cron schedule that runs a task on a recurring cron expression.
 * RRULE syntax is supported at the store layer but this helper currently defaults to cron.
 * The scheduler detects the `run_task:<taskId>` message format
 * and delegates to runTask() instead of processMessage().
 */
export function scheduleTask(opts: {
  taskId: string;
  name: string;
  cronExpression: string;
  timezone?: string;
}): ReturnType<typeof createSchedule> {
  return createSchedule({
    name: opts.name,
    cronExpression: opts.cronExpression,
    timezone: opts.timezone ?? null,
    message: `run_task:${opts.taskId}`,
  });
}
