import type { ToolContext, ToolExecutionResult } from '../types.js';
import { deleteSchedule, getSchedule } from '../../schedule/schedule-store.js';

export async function executeScheduleDelete(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const jobId = input.job_id as string;
  if (!jobId || typeof jobId !== 'string') {
    return { content: 'Error: job_id is required', isError: true };
  }

  // Fetch the job first for the confirmation message
  const job = getSchedule(jobId);
  if (!job) {
    return { content: `Error: Schedule not found: ${jobId}`, isError: true };
  }

  const deleted = deleteSchedule(jobId);
  if (!deleted) {
    return { content: `Error: Failed to delete schedule: ${jobId}`, isError: true };
  }

  return {
    content: `Schedule deleted: "${job.name}"`,
    isError: false,
  };
}
