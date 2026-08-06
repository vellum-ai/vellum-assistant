import { z } from "zod";

import { resolveCapabilities } from "../../runtime/capabilities.js";
import {
  formatScheduleInferenceProfile,
  validateScheduleInferenceProfile,
} from "../../schedule/inference-profile.js";
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
  setUserEnabled,
  updateSchedule,
} from "../../schedule/schedule-store.js";
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
 * Model-input schema, `safeParse`d at the top of {@link executeScheduleUpdate}.
 * Same in-tool pattern and drift guard as {@link scheduleCreateInputSchema}
 * in `create.ts` — see that schema's doc comment for the framework.
 *
 * Update-specific tolerance notes:
 *
 * - Presence semantics matter here (`input.x !== undefined` gates every
 *   update), so fields are plain `.optional()` — no null-to-omitted
 *   preprocessing that would silently turn an explicit update into a no-op.
 * - `timezone` and `script` are nullable at runtime though advertised as
 *   plain strings: `updateSchedule` persists null as "clear this field".
 * - `timeout_ms` / `group` advertise null (it reverts to the default), and
 *   `inference_profile` advertises null (it re-pins to the current default);
 *   the executor's bespoke handling stays.
 * - `mode`, `routing_intent`, `workflow_name`, and `workflow_args` are
 *   deliberately UNDECLARED (loose passthrough): the first two keep bespoke
 *   `VALID_*` errors; `workflow_name` has bespoke coercion semantics in the
 *   resolution below; `workflow_args` accepts any JSON value.
 */
export const scheduleUpdateInputSchema = z.looseObject({
  job_id: nullAsOmitted(z.string()),
  name: z.string().optional(),
  description: z.string().optional(),
  syntax: z.enum(["cron", "rrule"]).optional(),
  expression: z.string().optional(),
  timezone: z.string().nullable().optional(),
  message: z.string().optional(),
  script: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  routing_hints: z.looseObject({}).nullable().optional(),
  quiet: z.boolean().optional(),
  reuse_conversation: z.boolean().optional(),
  max_retries: z.int().optional(),
  retry_backoff_ms: z.int().optional(),
  timeout_ms: z.int().nullable().optional(),
  inference_profile: z.string().nullable().optional(),
  group: z.string().nullable().optional(),
});

export async function executeScheduleUpdate(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  if (!resolveCapabilities(context.trustClass).canManageSchedules) {
    return {
      content:
        "Error: schedule_update is restricted to guardian actors because schedules execute with elevated privileges.",
      isError: true,
    };
  }
  const parsedInput = scheduleUpdateInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return invalidToolInputResult("schedule_update", parsedInput.error);
  }
  const parsed = parsedInput.data;

  const jobId = parsed.job_id;
  if (!jobId) {
    return { content: "Error: job_id is required", isError: true };
  }

  const existing = getSchedule(jobId);

  // Prevent changing a one-shot to recurring or vice versa. (`fire_at` is
  // not an advertised update field, so it stays a raw-input read.)
  if (parsed.expression !== undefined || input.fire_at !== undefined) {
    if (!existing) {
      return { content: `Error: Schedule not found: ${jobId}`, isError: true };
    }
    const isExistingOneShot = existing.expression == null;
    if (isExistingOneShot && parsed.expression !== undefined) {
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
  if (parsed.name !== undefined) {
    updates.name = parsed.name;
  }
  if (parsed.description !== undefined) {
    const description = parsed.description;
    if (description.trim().length === 0) {
      return {
        content: "Error: description must be a non-empty string when provided",
        isError: true,
      };
    }
    updates.description = description;
  }
  if (parsed.timezone !== undefined) {
    updates.timezone = parsed.timezone;
  }
  if (parsed.message !== undefined) {
    updates.message = parsed.message;
  }
  if (parsed.script !== undefined) {
    updates.script = parsed.script;
  }
  if (parsed.enabled !== undefined) {
    updates.enabled = parsed.enabled;
  }

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
  if (parsed.routing_hints !== undefined) {
    updates.routingHints = parsed.routing_hints;
  }

  // Quiet mode
  if (parsed.quiet !== undefined) {
    updates.quiet = parsed.quiet;
  }

  // Conversation reuse
  if (parsed.reuse_conversation !== undefined) {
    updates.reuseConversation = parsed.reuse_conversation;
  }

  // Retry policy
  if (parsed.max_retries !== undefined) {
    updates.maxRetries = parsed.max_retries;
  }
  if (parsed.retry_backoff_ms !== undefined) {
    updates.retryBackoffMs = parsed.retry_backoff_ms;
  }

  // Inference profile (null re-pins the schedule to the currently resolved
  // default rather than leaving it to follow whatever the default becomes)
  if (parsed.inference_profile !== undefined) {
    if (parsed.inference_profile === null) {
      updates.inferenceProfile = null;
    } else {
      const profileError = validateScheduleInferenceProfile(
        parsed.inference_profile,
      );
      if (profileError) {
        return { content: `Error: ${profileError}`, isError: true };
      }
      updates.inferenceProfile = parsed.inference_profile;
    }
  }

  // Sidebar group for run conversations (null clears it, reverting to the
  // default system:scheduled). Applies to conversations created by future
  // runs; existing conversations stay where they are.
  if (parsed.group !== undefined) {
    if (parsed.group === null) {
      updates.groupId = null;
    } else {
      const resolvedGroup = resolveGroupReference(parsed.group);
      if ("error" in resolvedGroup) {
        return { content: `Error: ${resolvedGroup.error}`, isError: true };
      }
      updates.groupId = resolvedGroup.group.id;
    }
  }

  // Script execution timeout override (null clears it, reverting to default)
  if (parsed.timeout_ms !== undefined) {
    if (parsed.timeout_ms === null) {
      updates.timeoutMs = null;
    } else {
      const timeoutError = validateScriptTimeoutMs(parsed.timeout_ms);
      if (timeoutError) {
        return { content: `Error: ${timeoutError}`, isError: true };
      }
      updates.timeoutMs = parsed.timeout_ms;
    }
  }

  // Auto-detect syntax when expression changes without explicit syntax
  if (parsed.expression !== undefined || parsed.syntax !== undefined) {
    const resolved = normalizeScheduleSyntax({
      syntax: parsed.syntax,
      expression: parsed.expression,
    });
    if (resolved) {
      updates.syntax = resolved.syntax;
      updates.expression = resolved.expression;
    } else if (parsed.expression !== undefined) {
      updates.expression = parsed.expression;
      const detected = detectScheduleSyntax(parsed.expression);
      if (detected) {
        updates.syntax = detected;
      }
    }
    // When only syntax is provided (no expression), normalizeScheduleSyntax returns null
    // but we still need to persist the explicit syntax value.
    if (parsed.syntax !== undefined && updates.syntax === undefined) {
      updates.syntax = parsed.syntax;
    }
  }

  if (Object.keys(updates).length === 0) {
    return {
      content:
        "Error: No updates provided. Specify at least one field to update.",
      isError: true,
    };
  }

  // A plugin-sourced schedule accepts only the enabled toggle, recorded as
  // the user_enabled override exactly like the HTTP toggle route. Every other
  // field is owned by the plugin's schedule file, and the reconciler would
  // overwrite a direct edit on its next pass.
  const isPluginSourced = existing?.sourceKey != null;
  if (
    isPluginSourced &&
    Object.keys(updates).some((field) => field !== "enabled")
  ) {
    return {
      content:
        "Error: This schedule is managed by a plugin, so only enabled can be changed here. To change anything else, edit the plugin's schedule file.",
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
    if (existing) {
      const resultingMode =
        updates.mode !== undefined ? (updates.mode as string) : existing.mode;
      if (resultingMode === "workflow") {
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
    const job = isPluginSourced
      ? await setUserEnabled(jobId, updates.enabled as boolean)
      : await updateSchedule(
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
        `  Inference profile: ${formatScheduleInferenceProfile(job.inferenceProfile)}`,
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
