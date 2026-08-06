import { z } from "zod";

import { deleteSchedule, getSchedule } from "../../schedule/schedule-store.js";
import { UserError } from "../../util/errors.js";
import {
  invalidToolInputResult,
  nullAsOmitted,
} from "../shared/zod-tool-schema.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

/**
 * Model-input schema, `safeParse`d at the top of {@link executeScheduleDelete}.
 * Same in-tool pattern and drift guard as {@link scheduleCreateInputSchema}
 * in `create.ts` — see that schema's doc comment for the framework.
 */
export const scheduleDeleteInputSchema = z.looseObject({
  job_id: nullAsOmitted(z.string()),
});

export async function executeScheduleDelete(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const parsedInput = scheduleDeleteInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return invalidToolInputResult("schedule_delete", parsedInput.error);
  }
  const jobId = parsedInput.data.job_id;
  if (!jobId) {
    return { content: "Error: job_id is required", isError: true };
  }

  // Fetch the job first for the confirmation message
  const job = getSchedule(jobId);
  if (!job) {
    return { content: `Error: Schedule not found: ${jobId}`, isError: true };
  }

  let deleted: boolean;
  try {
    deleted = await deleteSchedule(jobId);
  } catch (err) {
    // The store refuses to delete plugin-sourced rows with a UserError. That
    // refusal is an expected outcome for the model to relay, not a daemon
    // fault to classify as unexpected.
    if (err instanceof UserError) {
      return { content: `Error: ${err.message}`, isError: true };
    }
    throw err;
  }
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
