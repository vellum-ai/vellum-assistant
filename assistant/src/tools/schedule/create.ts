import { formatIntegrationSummary } from "../../schedule/integration-status.js";
import { validateRruleSetLines } from "../../schedule/recurrence-engine.js";
import { normalizeScheduleSyntax } from "../../schedule/recurrence-types.js";
import {
  createSchedule,
  describeCronExpression,
  formatLocalDate,
  isValidCronExpression,
} from "../../schedule/schedule-store.js";
import type { ScheduleMode } from "../../schedule/schedule-store.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

const VALID_MODES: ScheduleMode[] = ["notify", "execute"];

export async function executeScheduleCreate(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const name = input.name as string;
  const timezone = (input.timezone as string) ?? null;
  const message = input.message as string;
  const enabled = (input.enabled as boolean) ?? true;
  const fireAt = input.fire_at as string | undefined;
  const mode = (input.mode as ScheduleMode | undefined) ?? "execute";
  const routingIntent = input.routing_intent as string | undefined;
  const routingHints = input.routing_hints as
    | Record<string, unknown>
    | undefined;

  if (!name || typeof name !== "string") {
    return {
      content: "Error: name is required and must be a string",
      isError: true,
    };
  }
  if (!message || typeof message !== "string") {
    return {
      content: "Error: message is required and must be a string",
      isError: true,
    };
  }

  // Validate mode
  if (!VALID_MODES.includes(mode)) {
    return {
      content: `Error: mode must be one of: ${VALID_MODES.join(", ")}`,
      isError: true,
    };
  }

  // ── One-shot schedule (fire_at) ──────────────────────────────────
  if (fireAt) {
    const fireAtMs = Date.parse(fireAt);
    if (isNaN(fireAtMs)) {
      return {
        content:
          "Error: fire_at must be a valid ISO 8601 timestamp (e.g. 2025-06-15T09:00:00Z)",
        isError: true,
      };
    }
    if (fireAtMs <= Date.now()) {
      return {
        content: "Error: fire_at must be in the future",
        isError: true,
      };
    }

    try {
      const job = createSchedule({
        name,
        cronExpression: null,
        timezone,
        message,
        enabled,
        syntax: "cron",
        expression: null,
        nextRunAt: fireAtMs,
        mode,
        routingIntent: routingIntent as
          | "single_channel"
          | "multi_channel"
          | "all_channels"
          | undefined,
        routingHints,
      });

      const fireDate = formatLocalDate(job.nextRunAt);
      const integrations = formatIntegrationSummary();
      return {
        content: [
          `One-shot schedule created successfully.`,
          `  ID: ${job.id}`,
          `  Name: ${job.name}`,
          `  Type: one-shot`,
          `  Mode: ${job.mode}`,
          `  Fire at: ${fireDate}`,
          `  Enabled: ${job.enabled}`,
          `  Status: ${job.status}`,
          ``,
          `Integrations: ${integrations}`,
          `\u26a0 If this schedule requires an integration that isn't connected, it will fail at runtime. Warn the user about any missing capabilities before confirming the schedule is ready.`,
        ].join("\n"),
        isError: false,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Error creating schedule: ${msg}`, isError: true };
    }
  }

  // ── Recurring schedule (expression) ──────────────────────────────
  const resolved = normalizeScheduleSyntax({
    syntax: input.syntax as "cron" | "rrule" | undefined,
    expression: input.expression as string | undefined,
  });

  if (!resolved) {
    return {
      content:
        "Error: expression is required for recurring schedules (or provide fire_at for one-shot)",
      isError: true,
    };
  }

  // Syntax-specific pre-validation for actionable error messages
  if (
    resolved.syntax === "cron" &&
    !isValidCronExpression(resolved.expression)
  ) {
    return {
      content: `Error: Invalid cron expression: "${resolved.expression}"`,
      isError: true,
    };
  }
  if (resolved.syntax === "rrule") {
    if (typeof resolved.expression !== "string") {
      return { content: "Error: expression must be a string", isError: true };
    }
    const setError = validateRruleSetLines(resolved.expression);
    if (setError) {
      return {
        content: `Error: ${setError}. Supported line types: DTSTART, RRULE, RDATE, EXDATE, EXRULE.`,
        isError: true,
      };
    }
  }

  try {
    const job = createSchedule({
      name,
      cronExpression: resolved.expression,
      timezone,
      message,
      enabled,
      syntax: resolved.syntax,
      expression: resolved.expression,
      mode,
      routingIntent: routingIntent as
        | "single_channel"
        | "multi_channel"
        | "all_channels"
        | undefined,
      routingHints,
    });

    const scheduleDescription =
      job.expression == null
        ? "One-time"
        : job.syntax === "rrule"
          ? job.expression
          : describeCronExpression(job.cronExpression);

    const nextRunDate = formatLocalDate(job.nextRunAt);
    const integrations = formatIntegrationSummary();
    return {
      content: [
        `Recurring schedule created successfully.`,
        `  ID: ${job.id}`,
        `  Name: ${job.name}`,
        `  Syntax: ${job.syntax}`,
        `  Mode: ${job.mode}`,
        `  Schedule: ${scheduleDescription}${
          job.timezone ? ` (${job.timezone})` : ""
        }`,
        `  Enabled: ${job.enabled}`,
        `  Next run: ${nextRunDate}`,
        ``,
        `Integrations: ${integrations}`,
        `\u26a0 If this schedule requires an integration that isn't connected, it will fail at runtime. Warn the user about any missing capabilities before confirming the schedule is ready.`,
      ].join("\n"),
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error creating schedule: ${msg}`, isError: true };
  }
}
