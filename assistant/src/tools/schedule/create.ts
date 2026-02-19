import type { ToolContext, ToolExecutionResult } from '../types.js';
import { createSchedule, isValidCronExpression, formatLocalDate, describeCronExpression } from '../../schedule/schedule-store.js';

export async function executeScheduleCreate(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const name = input.name as string;
  const cronExpression = input.cron_expression as string;
  const timezone = (input.timezone as string) ?? null;
  const message = input.message as string;
  const enabled = (input.enabled as boolean) ?? true;

  if (!name || typeof name !== 'string') {
    return { content: 'Error: name is required and must be a string', isError: true };
  }
  if (!cronExpression || typeof cronExpression !== 'string') {
    return { content: 'Error: cron_expression is required and must be a string', isError: true };
  }
  if (!message || typeof message !== 'string') {
    return { content: 'Error: message is required and must be a string', isError: true };
  }
  if (!isValidCronExpression(cronExpression)) {
    return { content: `Error: Invalid cron expression: "${cronExpression}"`, isError: true };
  }

  try {
    const job = createSchedule({ name, cronExpression, timezone, message, enabled });
    const nextRunDate = formatLocalDate(job.nextRunAt);
    return {
      content: [
        `Schedule created successfully.`,
        `  Name: ${job.name}`,
        `  Schedule: ${describeCronExpression(job.cronExpression)}${job.timezone ? ` (${job.timezone})` : ''}`,
        `  Enabled: ${job.enabled}`,
        `  Next run: ${nextRunDate}`,
      ].join('\n'),
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error creating schedule: ${msg}`, isError: true };
  }
}
