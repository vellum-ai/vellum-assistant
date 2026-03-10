import { validateRruleSetLines } from "../../schedule/recurrence-engine.js";
import {
  detectScheduleSyntax,
  normalizeScheduleSyntax,
  type ScheduleSyntax,
} from "../../schedule/recurrence-types.js";
import {
  describeCronExpression,
  formatLocalDate,
  updateSchedule,
} from "../../schedule/schedule-store.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

export async function executeScheduleUpdate(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const jobId = input.job_id as string;
  if (!jobId || typeof jobId !== "string") {
    return { content: "Error: job_id is required", isError: true };
  }

  const updates: Record<string, unknown> = {};
  if (input.name !== undefined) updates.name = input.name;
  if (input.timezone !== undefined) updates.timezone = input.timezone;
  if (input.message !== undefined) updates.message = input.message;
  if (input.enabled !== undefined) updates.enabled = input.enabled;

  // Auto-detect syntax when expression changes without explicit syntax
  if (input.expression !== undefined || input.syntax !== undefined) {
    const resolved = normalizeScheduleSyntax({
      syntax: input.syntax as "cron" | "rrule" | undefined,
      expression: input.expression as string | undefined,
    });
    if (resolved) {
      updates.syntax = resolved.syntax;
      updates.expression = resolved.expression;
    } else if (input.expression !== undefined) {
      updates.expression = input.expression;
      const detected = detectScheduleSyntax(input.expression as string);
      if (detected) updates.syntax = detected;
    }
    // When only syntax is provided (no expression), normalizeScheduleSyntax returns null
    // but we still need to persist the explicit syntax value.
    if (input.syntax !== undefined && updates.syntax === undefined) {
      updates.syntax = input.syntax;
    }
  }

  if (Object.keys(updates).length === 0) {
    return {
      content:
        "Error: No updates provided. Specify at least one field to update.",
      isError: true,
    };
  }

  // Set-aware pre-validation for RRULE expressions
  const effectiveSyntax = updates.syntax as string | undefined;
  const effectiveExpr =
    (updates.expression as string | undefined) ??
    (updates.cronExpression as string | undefined);
  if (
    effectiveExpr &&
    typeof effectiveExpr === "string" &&
    (effectiveSyntax === "rrule" || /^(DTSTART|RRULE:)/m.test(effectiveExpr))
  ) {
    const setError = validateRruleSetLines(effectiveExpr);
    if (setError) {
      return {
        content: `Error: ${setError}. Supported line types: DTSTART, RRULE, RDATE, EXDATE, EXRULE.`,
        isError: true,
      };
    }
  }

  try {
    const job = updateSchedule(
      jobId,
      updates as {
        name?: string;
        cronExpression?: string;
        timezone?: string | null;
        message?: string;
        enabled?: boolean;
        syntax?: ScheduleSyntax;
        expression?: string;
      },
    );

    if (!job) {
      return { content: `Error: Schedule not found: ${jobId}`, isError: true };
    }

    const scheduleDescription =
      job.expression == null
        ? "One-time"
        : job.syntax === "rrule"
          ? job.expression
          : describeCronExpression(job.cronExpression);

    return {
      content: [
        `Schedule updated successfully.`,
        `  Name: ${job.name}`,
        `  Syntax: ${job.syntax}`,
        `  Schedule: ${scheduleDescription}${job.timezone ? ` (${job.timezone})` : ""}`,
        `  Enabled: ${job.enabled}`,
        `  Next run: ${job.enabled ? formatLocalDate(job.nextRunAt) : "n/a (disabled)"}`,
      ].join("\n"),
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error updating schedule: ${msg}`, isError: true };
  }
}
