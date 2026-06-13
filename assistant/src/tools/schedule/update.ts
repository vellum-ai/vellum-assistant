import { isAssistantFeatureFlagEnabled } from "../../config/assistant-feature-flags.js";
import { getConfig } from "../../config/loader.js";
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
import type { ToolContext, ToolExecutionResult } from "../types.js";

const VALID_MODES: ScheduleMode[] = ["notify", "execute", "script", "workflow"];
const VALID_ROUTING_INTENTS: RoutingIntent[] = [
  "single_channel",
  "multi_channel",
  "all_channels",
];

export async function executeScheduleUpdate(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  if (context.trustClass !== "guardian") {
    return {
      content:
        "Error: schedule_update is restricted to guardian actors because schedules execute with elevated privileges.",
      isError: true,
    };
  }
  const jobId = input.job_id as string;
  if (!jobId || typeof jobId !== "string") {
    return { content: "Error: job_id is required", isError: true };
  }

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

  const updates: Record<string, unknown> = {};
  if (input.name !== undefined) updates.name = input.name;
  if (input.description !== undefined) {
    const description = input.description as string;
    if (typeof description !== "string" || description.trim().length === 0) {
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

  // Mode validation and pass-through
  if (input.mode !== undefined) {
    const mode = input.mode as ScheduleMode;
    if (!VALID_MODES.includes(mode)) {
      return {
        content: `Error: mode must be one of: ${VALID_MODES.join(", ")}`,
        isError: true,
      };
    }
    updates.mode = mode;
  }

  // Workflow fields pass-through (validated against the resulting mode below)
  if (input.workflow_name !== undefined) {
    updates.workflowName =
      typeof input.workflow_name === "string"
        ? input.workflow_name.trim()
        : null;
  }
  if (input.workflow_args !== undefined) {
    updates.workflowArgs = input.workflow_args;
  }

  // Routing intent validation and pass-through
  if (input.routing_intent !== undefined) {
    const routingIntent = input.routing_intent as RoutingIntent;
    if (!VALID_ROUTING_INTENTS.includes(routingIntent)) {
      return {
        content: `Error: routing_intent must be one of: ${VALID_ROUTING_INTENTS.join(", ")}`,
        isError: true,
      };
    }
    updates.routingIntent = routingIntent;
  }

  // Routing hints pass-through
  if (input.routing_hints !== undefined) {
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
      const inferenceProfile = input.inference_profile;
      if (typeof inferenceProfile !== "string") {
        return {
          content: "Error: inference_profile must be a string or null",
          isError: true,
        };
      }
      const profileError = validateScheduleInferenceProfile(inferenceProfile);
      if (profileError) {
        return { content: `Error: ${profileError}`, isError: true };
      }
      updates.inferenceProfile = inferenceProfile;
    }
  }

  // Script execution timeout override (null clears it, reverting to default)
  if (input.timeout_ms !== undefined) {
    if (input.timeout_ms === null) {
      updates.timeoutMs = null;
    } else {
      const timeoutMs = input.timeout_ms as number;
      const timeoutError = validateScriptTimeoutMs(timeoutMs);
      if (timeoutError) {
        return { content: `Error: ${timeoutError}`, isError: true };
      }
      updates.timeoutMs = timeoutMs;
    }
  }

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

  // Mirror the HTTP route: a schedule whose RESULTING mode is `workflow` must be
  // flag-enabled and carry a non-empty workflowName. Compute the post-update
  // state (the update's value if present, else the persisted one) so both
  // "switch to workflow without a name" and "clear the name on a workflow
  // schedule" are rejected — otherwise the scheduler hits the `!job.workflowName`
  // skip branch and a one-shot firing job wedges.
  if (updates.mode !== undefined || updates.workflowName !== undefined) {
    const existing = getSchedule(jobId);
    if (existing) {
      const resultingMode =
        updates.mode !== undefined ? (updates.mode as string) : existing.mode;
      if (resultingMode === "workflow") {
        if (!isAssistantFeatureFlagEnabled("workflows", getConfig())) {
          return {
            content: "Error: workflows are not enabled.",
            isError: true,
          };
        }
        const resultingWorkflowName =
          updates.workflowName !== undefined
            ? ((updates.workflowName as string | null) ?? "")
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
        description?: string;
        cronExpression?: string;
        timezone?: string | null;
        message?: string;
        script?: string | null;
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
