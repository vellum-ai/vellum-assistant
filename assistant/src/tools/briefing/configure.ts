import { getConfig } from "../../config/loader.js";
import { RiskLevel } from "../../permissions/types.js";
import { isUntrustedTrustClass } from "../../runtime/actor-trust-resolver.js";
import {
  createSchedule,
  isValidCronExpression,
  listSchedules,
  updateSchedule,
} from "../../schedule/schedule-store.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../types.js";
import {
  BRIEFING_DEFAULT_CRON,
  BRIEFING_SCHEDULE_NAME,
  DAILY_BRIEFING_PROMPT,
} from "./prompt.js";

type BriefingAction = "enable" | "disable" | "status" | "set_time";

function parseCronFromTime(time: string): string | null {
  const match = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${minute} ${hour} * * *`;
}

/**
 * Resolve the timezone to use for the briefing schedule.
 *
 * Priority:
 * 1. Explicit `timezone` argument passed by the agent.
 * 2. `ui.userTimezone` — the timezone the user set in their profile.
 * 3. `ui.detectedTimezone` — client-reported timezone (set on first login).
 * 4. System timezone of the host process (last resort; may be UTC in containers).
 */
function resolveTimezone(inputTz?: string): string {
  if (inputTz) return inputTz;
  const cfg = getConfig();
  const configured = cfg.ui?.userTimezone ?? cfg.ui?.detectedTimezone;
  if (configured) return configured;
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function findBriefingSchedule() {
  const all = listSchedules();
  return all.find((j) => j.name === BRIEFING_SCHEDULE_NAME) ?? null;
}

function formatStatus(job: ReturnType<typeof findBriefingSchedule>): string {
  if (!job) {
    return "No daily briefing is configured. Use action=enable to set one up.";
  }
  const state = job.enabled ? "enabled" : "disabled";
  const expr = job.expression ?? job.cronExpression ?? "(one-shot)";
  const tz = job.timezone ?? "system timezone";
  const lastRun = job.lastRunAt
    ? new Date(job.lastRunAt).toLocaleString()
    : "never";
  const nextRun = job.nextRunAt
    ? new Date(job.nextRunAt).toLocaleString()
    : "not scheduled";
  return [
    `Daily Briefing: ${state}`,
    `Schedule: ${expr} (${tz})`,
    `Last run: ${lastRun}`,
    `Next run: ${nextRun}`,
  ].join("\n");
}

export const dailyBriefingConfigureTool = {
  name: "daily_briefing_configure",
  description:
    "Configure the user's proactive daily briefing. The briefing fires on a recurring schedule, pulls recent memory and workspace context, composes a summary, and delivers it to all active channels (Slack, Telegram, macOS, etc.). Use action=enable to turn it on, action=disable to pause it, action=set_time to change delivery time (HH:MM format), or action=status to see the current configuration.",
  category: "memory",
  executionTarget: "sandbox",
  defaultRiskLevel: RiskLevel.Low,
  input_schema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["enable", "disable", "status", "set_time"],
        description:
          "enable: create or activate the daily briefing. disable: pause it without deleting. set_time: change the delivery time (requires time field). status: show current configuration.",
      },
      time: {
        type: "string",
        description:
          'Delivery time in HH:MM 24-hour format, e.g. "09:00" for 9 AM. Required for set_time; optional for enable (defaults to 09:00).',
      },
      timezone: {
        type: "string",
        description:
          'IANA timezone name, e.g. "America/New_York". Defaults to ui.userTimezone, then ui.detectedTimezone, then system timezone.',
      },
    },
    required: ["action"],
  },

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    if (isUntrustedTrustClass(context.trustClass)) {
      return {
        content:
          "daily_briefing_configure is only available to the guardian — it creates and modifies scheduled jobs.",
        isError: true,
      };
    }

    const action = input.action as BriefingAction;
    const rawTime = input.time as string | undefined;
    const rawTz = input.timezone as string | undefined;

    if (action === "status") {
      return { content: formatStatus(findBriefingSchedule()), isError: false };
    }

    if (action === "set_time") {
      if (!rawTime) {
        return {
          content: 'Error: time is required for set_time (e.g. "09:00").',
          isError: true,
        };
      }
      const cron = parseCronFromTime(rawTime);
      if (!cron) {
        return {
          content: `Error: invalid time "${rawTime}". Use HH:MM 24-hour format, e.g. "09:00".`,
          isError: true,
        };
      }
      if (!isValidCronExpression(cron)) {
        return {
          content: `Error: derived cron expression "${cron}" is not valid.`,
          isError: true,
        };
      }
      const job = findBriefingSchedule();
      if (!job) {
        return {
          content:
            "No daily briefing exists yet. Use action=enable to create one first.",
          isError: true,
        };
      }
      const updated = updateSchedule(job.id, {
        expression: cron,
        cronExpression: cron,
        timezone: resolveTimezone(rawTz),
      });
      if (!updated) {
        return {
          content: "Error: failed to update briefing schedule.",
          isError: true,
        };
      }
      return {
        content: `Daily briefing updated. New delivery time: ${rawTime} (${updated.timezone ?? "system timezone"}). Next run: ${new Date(updated.nextRunAt).toLocaleString()}.`,
        isError: false,
      };
    }

    if (action === "disable") {
      const job = findBriefingSchedule();
      if (!job) {
        return {
          content: "No daily briefing is configured, so nothing to disable.",
          isError: false,
        };
      }
      if (!job.enabled) {
        return {
          content: "Daily briefing is already disabled.",
          isError: false,
        };
      }
      updateSchedule(job.id, { enabled: false });
      return {
        content: "Daily briefing disabled. Use action=enable to resume it.",
        isError: false,
      };
    }

    // action === "enable" — validate time before writing anything
    if (rawTime !== undefined) {
      const cronCheck = parseCronFromTime(rawTime);
      if (!cronCheck) {
        return {
          content: `Error: invalid time "${rawTime}". Use HH:MM 24-hour format, e.g. "09:00".`,
          isError: true,
        };
      }
    }

    const timezone = resolveTimezone(rawTz);
    const timeStr = rawTime ?? "09:00";
    const cron = parseCronFromTime(timeStr) ?? BRIEFING_DEFAULT_CRON;

    const existing = findBriefingSchedule();
    if (existing) {
      const updated = updateSchedule(existing.id, {
        enabled: true,
        expression: cron,
        cronExpression: cron,
        timezone,
      });
      return {
        content: `Daily briefing enabled. Delivery: ${timeStr} (${timezone}). Next run: ${new Date(updated!.nextRunAt).toLocaleString()}.`,
        isError: false,
      };
    }

    // Create for the first time
    const job = createSchedule({
      name: BRIEFING_SCHEDULE_NAME,
      syntax: "cron",
      expression: cron,
      timezone,
      message: DAILY_BRIEFING_PROMPT,
      mode: "execute",
      enabled: true,
      createdBy: "agent",
      reuseConversation: true,
      quiet: false,
      maxRetries: 3,
      retryBackoffMs: 60_000,
    });

    return {
      content: `Daily briefing created and enabled. Delivery: ${timeStr} (${timezone}). First run: ${new Date(job.nextRunAt).toLocaleString()}.\n\nThe briefing will pull your recent memory and workspace context each morning, compose a summary, and send it to your active channels.`,
      isError: false,
    };
  },
} satisfies ToolDefinition;
