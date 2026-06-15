import { isAssistantFeatureFlagEnabled } from "../../config/assistant-feature-flags.js";
import { getConfig } from "../../config/loader.js";
import { validateScheduleInferenceProfile } from "../../schedule/inference-profile.js";
import { formatIntegrationSummary } from "../../schedule/integration-status.js";
import { validateRruleSetLines } from "../../schedule/recurrence-engine.js";
import { normalizeScheduleSyntax } from "../../schedule/recurrence-types.js";
import { validateScriptTimeoutMs } from "../../schedule/run-script.js";
import type {
  RoutingIntent,
  ScheduleMode,
} from "../../schedule/schedule-store.js";
import {
  createSchedule,
  describeCronExpression,
  formatLocalDate,
  isValidCronExpression,
} from "../../schedule/schedule-store.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

const VALID_MODES: ScheduleMode[] = ["notify", "execute", "script", "workflow"];
const VALID_ROUTING_INTENTS: RoutingIntent[] = [
  "single_channel",
  "multi_channel",
  "all_channels",
];

export async function executeScheduleCreate(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  if (context.trustClass !== "guardian") {
    return {
      content:
        "Error: schedule_create is restricted to guardian actors because schedules execute with elevated privileges.",
      isError: true,
    };
  }
  const name = input.name as string;
  const description = input.description as string | undefined;
  const timezone = (input.timezone as string) ?? null;
  const message = (input.message as string) ?? "";
  const script = (input.script as string) ?? null;
  const enabled = (input.enabled as boolean) ?? true;
  const fireAt = input.fire_at as string | undefined;
  const mode = (input.mode as ScheduleMode | undefined) ?? "execute";
  const routingIntent = input.routing_intent as string | undefined;
  const routingHints = input.routing_hints as
    | Record<string, unknown>
    | undefined;
  const quiet = (input.quiet as boolean) ?? false;
  const reuseConversation = input.reuse_conversation as boolean | undefined;
  const maxRetries = input.max_retries as number | undefined;
  const retryBackoffMs = input.retry_backoff_ms as number | undefined;
  const timeoutMs = input.timeout_ms as number | undefined;
  const workflowName =
    typeof input.workflow_name === "string" ? input.workflow_name.trim() : null;
  const workflowArgs = input.workflow_args;
  const inferenceProfile = input.inference_profile as string | undefined;

  if (timeoutMs !== undefined) {
    const timeoutError = validateScriptTimeoutMs(timeoutMs);
    if (timeoutError) {
      return { content: `Error: ${timeoutError}`, isError: true };
    }
  }

  if (inferenceProfile !== undefined) {
    if (typeof inferenceProfile !== "string") {
      return {
        content: "Error: inference_profile must be a string",
        isError: true,
      };
    }
    const profileError = validateScheduleInferenceProfile(inferenceProfile);
    if (profileError) {
      return { content: `Error: ${profileError}`, isError: true };
    }
  }

  if (!name || typeof name !== "string") {
    return {
      content: "Error: name is required and must be a string",
      isError: true,
    };
  }

  if (
    !description ||
    typeof description !== "string" ||
    description.trim().length === 0
  ) {
    return {
      content: "Error: description is required and must be a non-empty string",
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

  // Mode-specific field validation
  if (mode === "script") {
    if (!script || typeof script !== "string") {
      return {
        content:
          "Error: script is required for script mode and must be a non-empty string",
        isError: true,
      };
    }
  } else if (mode === "workflow") {
    // Workflow mode is gated by the `workflows` flag (a scheduled run would
    // otherwise hard-fail at trigger time) and requires a saved workflow name —
    // mirrors the HTTP route's create-side validation so the assistant-facing
    // path and the settings route enforce the same shape.
    if (!isAssistantFeatureFlagEnabled("workflows", getConfig())) {
      return { content: "Error: workflows are not enabled.", isError: true };
    }
    if (!workflowName) {
      return {
        content:
          "Error: workflow_name is required for workflow mode and must be a non-empty string",
        isError: true,
      };
    }
  } else {
    if (!message || typeof message !== "string") {
      return {
        content: "Error: message is required and must be a string",
        isError: true,
      };
    }
  }

  // Validate routing_intent
  if (
    routingIntent !== undefined &&
    !VALID_ROUTING_INTENTS.includes(routingIntent as RoutingIntent)
  ) {
    return {
      content: `Error: routing_intent must be one of: ${VALID_ROUTING_INTENTS.join(", ")}`,
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
    // Require explicit timezone (Z, ±HH:MM, or ±HHMM offset) to avoid host-timezone ambiguity
    if (!/(?:Z|[+-]\d{2}:?\d{2})\s*$/.test(fireAt)) {
      return {
        content:
          "Error: fire_at must include a timezone offset (e.g. 2025-06-15T09:00:00Z or 2025-06-15T09:00:00+05:30)",
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
        description,
        cronExpression: null,
        timezone,
        message,
        script,
        enabled,
        syntax: "cron",
        expression: null,
        nextRunAt: fireAtMs,
        mode,
        routingIntent: routingIntent as RoutingIntent | undefined,
        routingHints,
        quiet,
        reuseConversation,
        maxRetries,
        retryBackoffMs,
        timeoutMs,
        workflowName,
        workflowArgs,
        inferenceProfile,
        createdFromConversationId: context.conversationId,
      });

      const fireDate = formatLocalDate(job.nextRunAt);
      const integrations = await formatIntegrationSummary();
      return {
        content: [
          `One-shot schedule created successfully.`,
          `  ID: ${job.id}`,
          `  Name: ${job.name}`,
          `  Description: ${job.description}`,
          `  Type: one-shot`,
          `  Mode: ${job.mode}`,
          ...(job.inferenceProfile
            ? [`  Inference profile: ${job.inferenceProfile}`]
            : []),
          `  Fire at: ${fireDate}`,
          `  Enabled: ${job.enabled}`,
          `  Status: ${job.status}`,
          ``,
          `Integrations: ${integrations}`,
          `\u26a0 If this schedule requires an integration that isn't connected, it will fail at runtime. Warn about any missing capabilities before confirming the schedule is ready.`,
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
      description,
      cronExpression: resolved.expression,
      timezone,
      message,
      script,
      enabled,
      syntax: resolved.syntax,
      expression: resolved.expression,
      mode,
      routingIntent: routingIntent as RoutingIntent | undefined,
      routingHints,
      quiet,
      reuseConversation,
      maxRetries,
      retryBackoffMs,
      timeoutMs,
      workflowName,
      workflowArgs,
      inferenceProfile,
      createdFromConversationId: context.conversationId,
    });

    const scheduleDescription =
      job.expression == null
        ? "One-time"
        : job.syntax === "rrule"
          ? job.expression
          : describeCronExpression(job.cronExpression);

    const nextRunDate = formatLocalDate(job.nextRunAt);
    const integrations = await formatIntegrationSummary();
    return {
      content: [
        `Recurring schedule created successfully.`,
        `  ID: ${job.id}`,
        `  Name: ${job.name}`,
        `  Description: ${job.description}`,
        `  Syntax: ${job.syntax}`,
        `  Mode: ${job.mode}`,
        ...(job.inferenceProfile
          ? [`  Inference profile: ${job.inferenceProfile}`]
          : []),
        `  Schedule: ${scheduleDescription}${
          job.timezone ? ` (${job.timezone})` : ""
        }`,
        `  Enabled: ${job.enabled}`,
        `  Next run: ${nextRunDate}`,
        ``,
        `Integrations: ${integrations}`,
        `\u26a0 If this schedule requires an integration that isn't connected, it will fail at runtime. Warn about any missing capabilities before confirming the schedule is ready.`,
      ].join("\n"),
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error creating schedule: ${msg}`, isError: true };
  }
}
