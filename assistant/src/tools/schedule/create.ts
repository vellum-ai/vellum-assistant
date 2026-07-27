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
import { prepareScheduleSkillBinding } from "../../schedule/skill-binding.js";
import {
  CapabilityManifestSchema,
  resolveCapabilities as resolveWorkflowCapabilities,
} from "../../workflows/capabilities.js";
import { invalidToolInputResult } from "../shared/zod-tool-schema.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

export const VALID_MODES = [
  "notify",
  "execute",
  "script",
  "workflow",
] as const satisfies readonly ScheduleMode[];
export const VALID_ROUTING_INTENTS = [
  "single_channel",
  "multi_channel",
  "all_channels",
] as const satisfies readonly RoutingIntent[];

/**
 * Model-input schema. Validates field types and enum membership only; the
 * cross-field rules (mode-specific requirements, expression vs fire_at,
 * cron/RRULE syntax) stay in the executor body, which reads the parsed
 * values instead of casting raw input. `activity` is status-only and never
 * read here, so a malformed value degrades instead of failing the call.
 */
export const scheduleCreateInputSchema = z.looseObject({
  name: z.string().nullish(),
  description: z.string().nullish(),
  syntax: z.enum(["cron", "rrule"]).nullish(),
  expression: z.string().nullish(),
  fire_at: z.string().nullish(),
  timezone: z.string().nullish(),
  message: z.string().nullish(),
  script: z.string().nullish(),
  then_execute: z.boolean().nullish(),
  skill_id: z.string().nullish(),
  enabled: z.boolean().nullish(),
  mode: z
    .enum(VALID_MODES, {
      message: `mode must be one of: ${VALID_MODES.join(", ")}`,
    })
    .nullish(),
  workflow_name: z.string().nullish(),
  workflow_args: z.unknown(),
  capabilities: z.unknown(),
  routing_intent: z
    .enum(VALID_ROUTING_INTENTS, {
      message: `routing_intent must be one of: ${VALID_ROUTING_INTENTS.join(", ")}`,
    })
    .optional(),
  routing_hints: z.record(z.string(), z.unknown()).nullish(),
  quiet: z.boolean().nullish(),
  reuse_conversation: z.boolean().nullish(),
  max_retries: z.number().nullish(),
  retry_backoff_ms: z.number().nullish(),
  timeout_ms: z.number().nullish(),
  inference_profile: z
    .string({ message: "inference_profile must be a string" })
    .optional(),
  activity: z.string().optional().catch(undefined),
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
  const parsed = scheduleCreateInputSchema.safeParse(input);
  if (!parsed.success) {
    return invalidToolInputResult("schedule_create", parsed.error);
  }
  const name = parsed.data.name;
  const description = parsed.data.description;
  const timezone = parsed.data.timezone ?? null;
  const message = parsed.data.message ?? "";
  const script = parsed.data.script ?? null;
  const enabled = parsed.data.enabled ?? true;
  const fireAt = parsed.data.fire_at;
  const mode = parsed.data.mode ?? "execute";
  const routingIntent = parsed.data.routing_intent;
  const routingHints = parsed.data.routing_hints ?? undefined;
  const quiet = parsed.data.quiet ?? false;
  const reuseConversation = parsed.data.reuse_conversation ?? undefined;
  const maxRetries = parsed.data.max_retries ?? undefined;
  const retryBackoffMs = parsed.data.retry_backoff_ms ?? undefined;
  const timeoutMs = parsed.data.timeout_ms ?? undefined;
  const workflowName =
    typeof parsed.data.workflow_name === "string"
      ? parsed.data.workflow_name.trim()
      : null;
  const workflowArgs = parsed.data.workflow_args;
  const inferenceProfile = parsed.data.inference_profile;
  const thenExecute = parsed.data.then_execute ?? false;
  const skillId =
    typeof parsed.data.skill_id === "string"
      ? parsed.data.skill_id.trim()
      : null;

  // Validated workflow capability manifest, resolved only for workflow mode.
  // Left null for non-workflow modes so `createSchedule` persists no manifest.
  let capabilities: unknown = null;

  // Handoff + skill-binding fields, resolved only for script mode. The skill's
  // current content hash is pinned here so a later rewrite cannot keep firing
  // under this approval.
  let skillBinding: {
    thenExecute: boolean;
    skillId: string | null;
    skillVersionHash: string | null;
  } = { thenExecute: false, skillId: null, skillVersionHash: null };

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

  // Mode-specific field validation
  if (mode === "script") {
    if (!script) {
      return {
        content:
          "Error: script is required for script mode and must be a non-empty string",
        isError: true,
      };
    }
    const binding = prepareScheduleSkillBinding({
      skillId,
      thenExecute,
      message,
    });
    if (!binding.ok) {
      return { content: `Error: ${binding.error}`, isError: true };
    }
    skillBinding = binding.binding;
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
    if (parsed.data.capabilities !== undefined) {
      try {
        const manifest = CapabilityManifestSchema.parse(
          parsed.data.capabilities,
        );
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
    if (!message) {
      return {
        content: "Error: message is required and must be a string",
        isError: true,
      };
    }
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
        ...skillBinding,
        enabled,
        syntax: "cron",
        expression: null,
        nextRunAt: fireAtMs,
        mode,
        routingIntent,
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
    syntax: parsed.data.syntax ?? undefined,
    expression: parsed.data.expression ?? undefined,
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
      ...skillBinding,
      enabled,
      syntax: resolved.syntax,
      expression: resolved.expression,
      mode,
      routingIntent,
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
