import { z } from "zod";

import { resolveCapabilities } from "../../runtime/capabilities.js";
import { validateScheduleInferenceProfile } from "../../schedule/inference-profile.js";
import { validateRruleSetLines } from "../../schedule/recurrence-engine.js";
import {
  detectScheduleSyntax,
  normalizeScheduleSyntax,
  type ScheduleSyntax,
} from "../../schedule/recurrence-types.js";
import { validateScriptTimeoutMs } from "../../schedule/run-script.js";
import type {
  RoutingIntent,
  ScheduleMode,
} from "../../schedule/schedule-store.js";
import {
  describeCronExpression,
  formatLocalDate,
  getSchedule,
  updateSchedule,
} from "../../schedule/schedule-store.js";
import { resolveScheduleBindingUpdate } from "../../schedule/skill-binding.js";
import { invalidToolInputResult } from "../shared/zod-tool-schema.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";
import { VALID_MODES, VALID_ROUTING_INTENTS } from "./create.js";

/**
 * Model-input schema. Every field except `job_id` is a delta — present means
 * "apply this change" — so the schema validates types and enum membership
 * only, and the executor keeps its presence-driven update logic on the parsed
 * values. Fields where `null` means "clear the override" (`timezone`,
 * `script`, `skill_id`, `workflow_name`, `timeout_ms`, `inference_profile`)
 * are nullable; `fire_at` is presence-only (the executor never reads its
 * value, only rejects a one-shot/recurring conversion). `activity` is
 * status-only and never read here, so a malformed value degrades instead of
 * failing the call.
 */
export const scheduleUpdateInputSchema = z.looseObject({
  job_id: z
    .string({ message: "job_id is required" })
    .min(1, { message: "job_id is required" }),
  name: z.string().optional(),
  description: z.string().optional(),
  syntax: z.enum(["cron", "rrule"]).nullish(),
  expression: z.string().optional(),
  fire_at: z.unknown(),
  timezone: z.string().nullable().optional(),
  message: z.string().optional(),
  script: z.string().nullable().optional(),
  then_execute: z.boolean().optional(),
  skill_id: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  mode: z
    .enum(VALID_MODES, {
      message: `mode must be one of: ${VALID_MODES.join(", ")}`,
    })
    .optional(),
  workflow_name: z.string().nullable().optional(),
  workflow_args: z.unknown(),
  routing_intent: z
    .enum(VALID_ROUTING_INTENTS, {
      message: `routing_intent must be one of: ${VALID_ROUTING_INTENTS.join(", ")}`,
    })
    .optional(),
  routing_hints: z.record(z.string(), z.unknown()).nullish(),
  quiet: z.boolean().optional(),
  reuse_conversation: z.boolean().optional(),
  max_retries: z.number().optional(),
  retry_backoff_ms: z.number().optional(),
  timeout_ms: z.number().nullable().optional(),
  inference_profile: z
    .string({ message: "inference_profile must be a string or null" })
    .nullable()
    .optional(),
  activity: z.string().optional().catch(undefined),
});

export async function executeScheduleUpdate(
  rawInput: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  if (!resolveCapabilities(context.trustClass).canManageSchedules) {
    return {
      content:
        "Error: schedule_update is restricted to guardian actors because schedules execute with elevated privileges.",
      isError: true,
    };
  }
  const parsed = scheduleUpdateInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidToolInputResult("schedule_update", parsed.error);
  }
  const input = parsed.data;
  const jobId = input.job_id;

  // Prevent changing a one-shot to recurring or vice versa
  if (input.expression !== undefined || input.fire_at !== undefined) {
    const existing = getSchedule(jobId);
    if (!existing) {
      return { content: `Error: Schedule not found: ${jobId}`, isError: true };
    }
    const isExistingOneShot = existing.expression == null;
    if (isExistingOneShot && input.expression !== undefined) {
      return {
        content:
          "Error: Cannot change a one-shot schedule to recurring. Delete and recreate instead.",
        isError: true,
      };
    }
    if (!isExistingOneShot && input.fire_at !== undefined) {
      return {
        content:
          "Error: Cannot change a recurring schedule to one-shot. Delete and recreate instead.",
        isError: true,
      };
    }
  }

  const updates: {
    name?: string;
    description?: string;
    cronExpression?: string;
    timezone?: string | null;
    message?: string;
    script?: string | null;
    thenExecute?: boolean;
    skillId?: string | null;
    skillVersionHash?: string | null;
    enabled?: boolean;
    syntax?: ScheduleSyntax;
    expression?: string;
    mode?: ScheduleMode;
    routingIntent?: RoutingIntent;
    routingHints?: Record<string, unknown>;
    quiet?: boolean;
    reuseConversation?: boolean;
    maxRetries?: number;
    retryBackoffMs?: number;
    timeoutMs?: number | null;
    workflowName?: string | null;
    workflowArgs?: unknown;
    inferenceProfile?: string | null;
  } = {};
  if (input.name !== undefined) updates.name = input.name;
  if (input.description !== undefined) {
    const description = input.description;
    if (description.trim().length === 0) {
      return {
        content: "Error: description must be a non-empty string when provided",
        isError: true,
      };
    }
    updates.description = description;
  }
  if (input.timezone !== undefined) updates.timezone = input.timezone;
  if (input.message !== undefined) updates.message = input.message;
  if (input.script !== undefined) updates.script = input.script;
  if (input.enabled !== undefined) updates.enabled = input.enabled;

  // Validate the handoff whenever the toggle or the action prompt moves.
  // `message` matters because it becomes the handoff's trusted postamble:
  // clearing it on an existing `then_execute` schedule would leave the turn
  // with untrusted stdout and no instruction after it.
  if (
    input.then_execute !== undefined ||
    input.skill_id !== undefined ||
    input.message !== undefined
  ) {
    const existing = getSchedule(jobId);
    if (!existing) {
      return { content: `Error: Schedule not found: ${jobId}`, isError: true };
    }

    const binding = resolveScheduleBindingUpdate({
      existing,
      ...(input.then_execute !== undefined
        ? { thenExecute: input.then_execute === true }
        : {}),
      ...(input.skill_id !== undefined ? { skillId: input.skill_id } : {}),
      ...(input.message !== undefined ? { message: input.message } : {}),
    });
    if (!binding.ok) {
      return { content: `Error: ${binding.error}`, isError: true };
    }
    Object.assign(updates, binding.updates);
  }

  // Mode pass-through (enum membership enforced by the schema)
  if (input.mode !== undefined) {
    updates.mode = input.mode;
  }

  // Workflow fields pass-through (validated against the resulting mode below)
  if (input.workflow_name !== undefined) {
    updates.workflowName = input.workflow_name?.trim() ?? null;
  }
  if (input.workflow_args !== undefined) {
    updates.workflowArgs = input.workflow_args;
  }

  // Routing intent pass-through (enum membership enforced by the schema)
  if (input.routing_intent !== undefined) {
    updates.routingIntent = input.routing_intent;
  }

  // Routing hints pass-through
  if (input.routing_hints != null) {
    updates.routingHints = input.routing_hints;
  }

  // Quiet mode
  if (input.quiet !== undefined) {
    updates.quiet = input.quiet;
  }

  // Conversation reuse
  if (input.reuse_conversation !== undefined) {
    updates.reuseConversation = input.reuse_conversation;
  }

  // Retry policy
  if (input.max_retries !== undefined) {
    updates.maxRetries = input.max_retries;
  }
  if (input.retry_backoff_ms !== undefined) {
    updates.retryBackoffMs = input.retry_backoff_ms;
  }

  // Inference profile override (null clears it, reverting to the default
  // main-agent model selection)
  if (input.inference_profile !== undefined) {
    if (input.inference_profile === null) {
      updates.inferenceProfile = null;
    } else {
      const profileError = validateScheduleInferenceProfile(
        input.inference_profile,
      );
      if (profileError) {
        return { content: `Error: ${profileError}`, isError: true };
      }
      updates.inferenceProfile = input.inference_profile;
    }
  }

  // Script execution timeout override (null clears it, reverting to default)
  if (input.timeout_ms !== undefined) {
    if (input.timeout_ms === null) {
      updates.timeoutMs = null;
    } else {
      const timeoutError = validateScriptTimeoutMs(input.timeout_ms);
      if (timeoutError) {
        return { content: `Error: ${timeoutError}`, isError: true };
      }
      updates.timeoutMs = input.timeout_ms;
    }
  }

  // Auto-detect syntax when expression changes without explicit syntax
  if (input.expression !== undefined || input.syntax !== undefined) {
    const resolved = normalizeScheduleSyntax({
      syntax: input.syntax ?? undefined,
      expression: input.expression,
    });
    if (resolved) {
      updates.syntax = resolved.syntax;
      updates.expression = resolved.expression;
    } else if (input.expression !== undefined) {
      updates.expression = input.expression;
      const detected = detectScheduleSyntax(input.expression);
      if (detected) updates.syntax = detected;
    }
    // When only syntax is provided (no expression), normalizeScheduleSyntax returns null
    // but we still need to persist the explicit syntax value.
    if (input.syntax != null && updates.syntax === undefined) {
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

  // Mirror the HTTP route: a schedule whose RESULTING mode is `workflow` must
  // carry a non-empty workflowName. Compute the post-update
  // state (the update's value if present, else the persisted one) so both
  // "switch to workflow without a name" and "clear the name on a workflow
  // schedule" are rejected — otherwise the scheduler hits the `!job.workflowName`
  // skip branch and a one-shot firing job wedges.
  if (updates.mode !== undefined || updates.workflowName !== undefined) {
    const existing = getSchedule(jobId);
    if (existing) {
      const resultingMode =
        updates.mode !== undefined ? updates.mode : existing.mode;
      if (resultingMode === "workflow") {
        const resultingWorkflowName =
          updates.workflowName !== undefined
            ? (updates.workflowName ?? "")
            : (existing.workflowName ?? "");
        if (!resultingWorkflowName) {
          return {
            content:
              "Error: workflow_name is required for workflow-mode schedules",
            isError: true,
          };
        }
      }
    }
  }

  // Set-aware pre-validation for RRULE expressions
  const effectiveSyntax = updates.syntax;
  const effectiveExpr = updates.expression ?? updates.cronExpression;
  if (
    effectiveExpr &&
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
    const job = await updateSchedule(jobId, updates);

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
        `  Description: ${job.description}`,
        `  Syntax: ${job.syntax}`,
        `  Mode: ${job.mode}`,
        `  Inference profile: ${job.inferenceProfile ?? "default (mainAgent)"}`,
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
