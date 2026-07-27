import { z } from "zod";

import { deleteSchedule, getSchedule } from "../../schedule/schedule-store.js";
import { invalidToolInputResult } from "../shared/zod-tool-schema.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

/**
 * Model-input schema. `activity` is status-only and never read here, so a
 * malformed value degrades instead of failing the call.
 */
export const scheduleDeleteInputSchema = z.looseObject({
  job_id: z
    .string({ message: "job_id is required" })
    .min(1, { message: "job_id is required" }),
  activity: z.string().optional().catch(undefined),
});

export async function executeScheduleDelete(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const parsed = scheduleDeleteInputSchema.safeParse(input);
  if (!parsed.success) {
    return invalidToolInputResult("schedule_delete", parsed.error);
  }
  const jobId = parsed.data.job_id;

  // Fetch the job first for the confirmation message
  const job = getSchedule(jobId);
  if (!job) {
    return { content: `Error: Schedule not found: ${jobId}`, isError: true };
  }

  const deleted = await deleteSchedule(jobId);
  if (!deleted) {
    return {
      content: `Error: Failed to delete schedule: ${jobId}`,
      isError: true,
    };
  }

  return {
    content: `Schedule deleted: "${job.name}"`,
    isError: false,
  };
}
