import { z } from "zod";

import { resolveCapabilities } from "../../runtime/capabilities.js";
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
import {
  CapabilityManifestSchema,
  resolveCapabilities as resolveWorkflowCapabilities,
} from "../../workflows/capabilities.js";
import { resolveGroupReference } from "../conversation-groups/group_shared.js";
import {
  invalidToolInputResult,
  nullAsOmitted,
} from "../shared/zod-tool-schema.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

const VALID_MODES: ScheduleMode[] = ["notify", "execute", "script", "workflow"];
const VALID_ROUTING_INTENTS: RoutingIntent[] = [
  "single_channel",
  "multi_channel",
  "all_channels",
];

/**
 * Model-input schema, `safeParse`d at the top of {@link executeScheduleCreate}.
 * Skill-owned tools are skipped by the central `TOOL_INPUT_SCHEMAS` gate, so
 * validation lives in the executor (`ask_question` pre-registry precedent);
 * the advertised `input_schema` stays hand-written in the schedule skill's
 * `TOOLS.json`, and `schedule-tool-input-schemas.test.ts` guards the two
 * against structural drift.
 *
 * Tolerance matches the executor's own reads — this schema only rejects
 * values the executor would otherwise pass into the store unchecked:
 *
 * - `nullAsOmitted` on optionals read via `?? fallback`, where null and
 *   absent are equivalent.
 * - `.catch(undefined)` on `workflow_name`, which the executor
 *   silently coerces to null when malformed.
 * - `mode`, `routing_intent`, `capabilities`, and `workflow_args` are
 *   deliberately UNDECLARED (loose passthrough): the first two keep their
 *   bespoke `VALID_*` error messages, `capabilities` must reach
 *   `CapabilityManifestSchema` (and the `requireFreshApproval` promotion in
 *   `executor.ts`) unaltered, and `workflow_args` accepts any JSON value the
 *   workflow runtime accepts.
 */
export const scheduleCreateInputSchema = z.looseObject({
  name: nullAsOmitted(z.string()),
  description: nullAsOmitted(z.string()),
  syntax: nullAsOmitted(z.enum(["cron", "rrule"])),
  expression: nullAsOmitted(z.string()),
  fire_at: nullAsOmitted(z.string()),
  timezone: nullAsOmitted(z.string()),
  message: nullAsOmitted(z.string()),
  script: nullAsOmitted(z.string()),
  enabled: nullAsOmitted(z.boolean()),
  workflow_name: z.string().optional().catch(undefined),
  routing_hints: nullAsOmitted(z.looseObject({})),
  quiet: nullAsOmitted(z.boolean()),
  reuse_conversation: nullAsOmitted(z.boolean()),
  max_retries: nullAsOmitted(z.int()),
  retry_backoff_ms: nullAsOmitted(z.int()),
  timeout_ms: z.int().optional(),
  inference_profile: z.string().optional(),
  group: nullAsOmitted(z.string()),
});

export async function executeScheduleCreate(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  if (!resolveCapabilities(context.trustClass).canManageSchedules) {
    return {
      content:
        "Error: schedule_create is restricted to guardian actors because schedules execute with elevated privileges.",
      isError: true,
    };
  }
  const parsedInput = scheduleCreateInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return invalidToolInputResult("schedule_create", parsedInput.error);
  }
  const parsed = parsedInput.data;

  const name = parsed.name;
  const description = parsed.description;
  const timezone = parsed.timezone ?? null;
  const message = parsed.message ?? "";
  const script = parsed.script ?? null;
  const enabled = parsed.enabled ?? true;
  const fireAt = parsed.fire_at;
  // mode / routing_intent / workflow_args (and capabilities, read below) stay
  // raw-input reads: they are undeclared in the schema (see its doc comment).
  const mode = (input.mode as ScheduleMode | undefined) ?? "execute";
  const routingIntent = input.routing_intent as string | undefined;
  const routingHints = parsed.routing_hints;
  const quiet = parsed.quiet ?? false;
  const reuseConversation = parsed.reuse_conversation;
  const maxRetries = parsed.max_retries;
  const retryBackoffMs = parsed.retry_backoff_ms;
  const timeoutMs = parsed.timeout_ms;
  const workflowName = parsed.workflow_name?.trim() ?? null;
  const workflowArgs = input.workflow_args;
  const inferenceProfile = parsed.inference_profile;

  // Validated workflow capability manifest, resolved only for workflow mode.
  // Left null for non-workflow modes so `createSchedule` persists no manifest.
  let capabilities: unknown = null;

  if (timeoutMs !== undefined) {
    const timeoutError = validateScriptTimeoutMs(timeoutMs);
    if (timeoutError) {
      return { content: `Error: ${timeoutError}`, isError: true };
    }
  }

  if (inferenceProfile !== undefined) {
    const profileError = validateScheduleInferenceProfile(inferenceProfile);
    if (profileError) {
      return { content: `Error: ${profileError}`, isError: true };
    }
  }

  // Sidebar group for run conversations; null = default system:scheduled.
  let groupId: string | null = null;
  let groupName: string | null = null;
  if (parsed.group !== undefined) {
    const resolvedGroup = resolveGroupReference(parsed.group);
    if ("error" in resolvedGroup) {
      return { content: `Error: ${resolvedGroup.error}`, isError: true };
    }
    groupId = resolvedGroup.group.id;
    groupName = resolvedGroup.group.name;
  }

  if (!name) {
    return {
      content: "Error: name is required and must be a string",
      isError: true,
    };
  }

  if (!description || description.trim().length === 0) {
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
    if (!script) {
      return {
        content:
          "Error: script is required for script mode and must be a non-empty string",
        isError: true,
      };
    }
  } else if (mode === "workflow") {
    // Workflow mode requires a saved workflow name — mirrors the HTTP route's
    // create-side validation so the assistant-facing path and the settings route
    // enforce the same shape.
    if (!workflowName) {
      return {
        content:
          "Error: workflow_name is required for workflow mode and must be a non-empty string",
        isError: true,
      };
    }
    // A workflow schedule may carry a capability manifest — the single consent
    // point for its eventual unattended run. Validate and normalize it here so a
    // schedule can never persist a malformed or forbidden manifest: parse the
    // declared shape, then run the same forbidden/unknown/host-tool checks
    // resolveCapabilities applies at launch. A side-effecting manifest forces a
    // fresh approval at CREATION (see executor.ts).
    if (input.capabilities !== undefined) {
      try {
        const manifest = CapabilityManifestSchema.parse(input.capabilities);
        resolveWorkflowCapabilities(manifest);
        capabilities = manifest;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: `Error: invalid capabilities manifest: ${msg}`,
          isError: true,
        };
      }
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
      const job = await createSchedule({
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
        capabilities,
        inferenceProfile,
        groupId,
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
          ...(groupName ? [`  Conversation group: ${groupName}`] : []),
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
    syntax: parsed.syntax,
    expression: parsed.expression,
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
    const job = await createSchedule({
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
      capabilities,
      inferenceProfile,
      groupId,
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
        ...(groupName ? [`  Conversation group: ${groupName}`] : []),
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
