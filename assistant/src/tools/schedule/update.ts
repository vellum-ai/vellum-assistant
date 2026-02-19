import type { ToolContext, ToolExecutionResult } from '../types.js';
import { updateSchedule, formatLocalDate, describeCronExpression } from '../../schedule/schedule-store.js';

export async function executeScheduleUpdate(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const jobId = input.job_id as string;
  if (!jobId || typeof jobId !== 'string') {
    return { content: 'Error: job_id is required', isError: true };
  }

  const updates: Record<string, unknown> = {};
  if (input.name !== undefined) updates.name = input.name;
  if (input.cron_expression !== undefined) updates.cronExpression = input.cron_expression;
  if (input.timezone !== undefined) updates.timezone = input.timezone;
  if (input.message !== undefined) updates.message = input.message;
  if (input.enabled !== undefined) updates.enabled = input.enabled;

  if (Object.keys(updates).length === 0) {
    return { content: 'Error: No updates provided. Specify at least one field to update.', isError: true };
  }

  try {
    const job = updateSchedule(jobId, updates as {
      name?: string;
      cronExpression?: string;
      timezone?: string | null;
      message?: string;
      enabled?: boolean;
    });

    if (!job) {
      return { content: `Error: Schedule not found: ${jobId}`, isError: true };
    }

    return {
      content: [
        `Schedule updated successfully.`,
        `  Name: ${job.name}`,
        `  Schedule: ${describeCronExpression(job.cronExpression)}${job.timezone ? ` (${job.timezone})` : ''}`,
        `  Enabled: ${job.enabled}`,
        `  Next run: ${job.enabled ? formatLocalDate(job.nextRunAt) : 'n/a (disabled)'}`,
      ].join('\n'),
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error updating schedule: ${msg}`, isError: true };
  }
}
