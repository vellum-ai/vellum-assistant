/**
 * Route handlers for schedule management.
 *
 * All routes are served by both the HTTP server and the IPC server via
 * the shared ROUTES array.
 */

import { z } from "zod";

import { getOrCreateConversation } from "../../daemon/conversation-store.js";
import { INTERNAL_GUARDIAN_TRUST_CONTEXT } from "../../daemon/trust-context.js";
import { bootstrapConversation } from "../../memory/conversation-bootstrap.js";
import { getConversation } from "../../memory/conversation-crud.js";
import { runScript } from "../../schedule/run-script.js";
import {
  cancelSchedule,
  completeScheduleRun,
  createScheduleRun,
  deleteSchedule,
  describeCronExpression,
  getLastScheduleConversationId,
  getSchedule,
  getScheduleRuns,
  listSchedules,
  updateSchedule,
} from "../../schedule/schedule-store.js";
import { getLogger } from "../../util/logger.js";
import { BadRequestError, InternalError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("schedule-routes");

// ---------------------------------------------------------------------------
// Handlers (transport-agnostic)
// ---------------------------------------------------------------------------

function handleListSchedules(queryParams: Record<string, string>) {
  const includeAll = queryParams.include_all === "true";
  const jobs = listSchedules();
  const filtered = includeAll
    ? jobs
    : jobs.filter((j) => j.createdBy !== "defer");
  return {
    schedules: filtered.map((j) => ({
      id: j.id,
      name: j.name,
      enabled: j.enabled,
      syntax: j.syntax,
      expression: j.expression,
      cronExpression: j.cronExpression,
      timezone: j.timezone,
      message: j.message,
      script: j.script,
      nextRunAt: j.nextRunAt,
      lastRunAt: j.lastRunAt,
      lastStatus: j.lastStatus,
      retryCount: j.retryCount,
      maxRetries: j.maxRetries,
      retryBackoffMs: j.retryBackoffMs,
      description:
        j.syntax === "cron"
          ? describeCronExpression(j.cronExpression)
          : j.expression,
      mode: j.mode,
      status: j.status,
      routingIntent: j.routingIntent,
      reuseConversation: j.reuseConversation,
      wakeConversationId: j.wakeConversationId,
      isOneShot: j.cronExpression == null,
    })),
  };
}

function handleToggleSchedule(id: string, body: Record<string, unknown>) {
  const enabled = body.enabled;
  if (typeof enabled !== "boolean") {
    throw new BadRequestError("enabled is required");
  }

  const updated = updateSchedule(id, { enabled });
  if (!updated) {
    throw new NotFoundError("Schedule not found");
  }
  log.info({ id, enabled }, "Schedule toggled");
  return handleListSchedules({});
}

function handleDeleteSchedule(id: string) {
  const removed = deleteSchedule(id);
  if (!removed) {
    throw new NotFoundError("Schedule not found");
  }
  log.info({ id }, "Schedule removed");
  return handleListSchedules({});
}

function handleCancelSchedule(id: string) {
  const cancelled = cancelSchedule(id);
  if (!cancelled) {
    throw new NotFoundError("Schedule not found or not cancellable");
  }
  log.info({ id }, "Schedule cancelled");
  return handleListSchedules({});
}

const VALID_MODES = ["notify", "execute", "script", "wake"] as const;
const VALID_ROUTING_INTENTS = [
  "single_channel",
  "multi_channel",
  "all_channels",
] as const;

function handleUpdateSchedule(id: string, body: Record<string, unknown>) {
  if (
    "mode" in body &&
    !VALID_MODES.includes(body.mode as (typeof VALID_MODES)[number])
  ) {
    throw new BadRequestError(
      `Invalid mode: must be one of ${VALID_MODES.join(", ")}`,
    );
  }
  if (
    "routingIntent" in body &&
    !VALID_ROUTING_INTENTS.includes(
      body.routingIntent as (typeof VALID_ROUTING_INTENTS)[number],
    )
  ) {
    throw new BadRequestError(
      `Invalid routingIntent: must be one of ${VALID_ROUTING_INTENTS.join(", ")}`,
    );
  }

  const updates: Record<string, unknown> = {};
  for (const key of [
    "name",
    "expression",
    "timezone",
    "message",
    "script",
    "mode",
    "routingIntent",
    "quiet",
    "reuseConversation",
    "wakeConversationId",
    "maxRetries",
    "retryBackoffMs",
  ] as const) {
    if (key in body) {
      updates[key] = body[key];
    }
  }

  try {
    const updated = updateSchedule(id, updates);
    if (!updated) {
      throw new NotFoundError("Schedule not found");
    }
    log.info({ id, updates }, "Schedule updated");
  } catch (err) {
    if (err instanceof NotFoundError || err instanceof BadRequestError) {
      throw err;
    }
    if (
      err instanceof Error &&
      (err.message.includes("Invalid") || err.message.includes("invalid"))
    ) {
      throw new BadRequestError(err.message);
    }
    throw err;
  }
  return handleListSchedules({});
}

function handleListScheduleRuns(
  id: string,
  queryParams: Record<string, string>,
) {
  const schedule = getSchedule(id);
  if (!schedule) {
    throw new NotFoundError("Schedule not found");
  }
  const rawLimit = Number(queryParams.limit ?? 10);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.floor(rawLimit), 1), 100)
    : 10;
  const runs = getScheduleRuns(id, limit);
  return {
    runs: runs.map((r) => ({
      id: r.id,
      jobId: r.jobId,
      status: r.status,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      durationMs: r.durationMs,
      output: r.output,
      error: r.error,
      conversationId: r.conversationId,
      createdAt: r.createdAt,
    })),
  };
}

// ---------------------------------------------------------------------------
// Shared route definitions (HTTP + IPC)
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "listSchedules",
    endpoint: "schedules",
    method: "GET",
    policyKey: "schedules",
    summary: "List schedules",
    description: "Return all scheduled jobs.",
    tags: ["schedules"],
    queryParams: [
      {
        name: "include_all",
        schema: { type: "string" },
        description:
          "When 'true', include deferred schedules that are normally hidden.",
      },
    ],
    responseBody: z.object({
      schedules: z.array(z.unknown()).describe("Schedule objects"),
    }),
    handler: ({ queryParams }: RouteHandlerArgs) =>
      handleListSchedules(queryParams ?? {}),
  },
  {
    operationId: "listScheduleRuns",
    endpoint: "schedules/:id/runs",
    method: "GET",
    policyKey: "schedules",
    summary: "List schedule runs",
    description: "Return recent invocation history for a schedule.",
    tags: ["schedules"],
    queryParams: [
      {
        name: "limit",
        schema: { type: "integer" },
        description: "Max runs to return (default 10, max 100)",
      },
    ],
    responseBody: z.object({
      runs: z.array(z.unknown()).describe("Schedule run objects"),
    }),
    handler: ({ pathParams, queryParams }: RouteHandlerArgs) =>
      handleListScheduleRuns(pathParams!.id, queryParams ?? {}),
  },
  {
    operationId: "toggleSchedule",
    endpoint: "schedules/:id/toggle",
    method: "POST",
    policyKey: "schedules/toggle",
    summary: "Toggle schedule",
    description: "Enable or disable a schedule.",
    tags: ["schedules"],
    requestBody: z.object({
      enabled: z.boolean().describe("New enabled state"),
    }),
    responseBody: z.object({
      schedules: z.array(z.unknown()).describe("Updated schedule list"),
    }),
    handler: ({ pathParams, body }: RouteHandlerArgs) =>
      handleToggleSchedule(pathParams!.id, body ?? {}),
  },
  {
    operationId: "deleteSchedule",
    endpoint: "schedules/:id",
    method: "DELETE",
    policyKey: "schedules",
    summary: "Delete schedule",
    description: "Remove a schedule by ID.",
    tags: ["schedules"],
    responseBody: z.object({
      schedules: z.array(z.unknown()).describe("Updated schedule list"),
    }),
    handler: ({ pathParams }: RouteHandlerArgs) =>
      handleDeleteSchedule(pathParams!.id),
  },
  {
    operationId: "updateSchedule",
    endpoint: "schedules/:id",
    method: "PATCH",
    policyKey: "schedules",
    summary: "Update schedule",
    description: "Partially update fields on a schedule.",
    tags: ["schedules"],
    requestBody: z.object({
      name: z.string(),
      expression: z.string(),
      timezone: z.string(),
      message: z.string(),
      script: z.string().nullable().describe("Shell command for script mode"),
      mode: z.string().describe("notify, execute, or script"),
      routingIntent: z
        .string()
        .describe("single_channel, multi_channel, or all_channels"),
      quiet: z.boolean(),
      reuseConversation: z.boolean(),
      maxRetries: z.number().describe("Maximum retry attempts"),
      retryBackoffMs: z.number().describe("Retry backoff in milliseconds"),
    }),
    responseBody: z.object({
      schedules: z.array(z.unknown()).describe("Updated schedule list"),
    }),
    handler: ({ pathParams, body }: RouteHandlerArgs) =>
      handleUpdateSchedule(pathParams!.id, body ?? {}),
  },
  {
    operationId: "cancelSchedule",
    endpoint: "schedules/:id/cancel",
    method: "POST",
    policyKey: "schedules/cancel",
    summary: "Cancel schedule",
    description: "Cancel a pending schedule.",
    tags: ["schedules"],
    responseBody: z.object({
      schedules: z.array(z.unknown()).describe("Updated schedule list"),
    }),
    handler: ({ pathParams }: RouteHandlerArgs) =>
      handleCancelSchedule(pathParams!.id),
  },
  {
    operationId: "runScheduleNow",
    endpoint: "schedules/:id/run",
    method: "POST",
    policyKey: "schedules/run",
    summary: "Run schedule now",
    description: "Trigger an immediate execution of a schedule.",
    tags: ["schedules"],
    responseBody: z.object({
      schedules: z.array(z.unknown()).describe("Updated schedule list"),
    }),
    handler: ({ pathParams }: RouteHandlerArgs) =>
      handleRunScheduleNow(pathParams!.id),
  },
];

async function handleRunScheduleNow(id: string) {
  const schedule = getSchedule(id);
  if (!schedule) {
    throw new NotFoundError("Schedule not found");
  }

  // ── Script mode (shell command, no LLM) ──────────────────────────
  if (schedule.mode === "script") {
    if (!schedule.script) {
      throw new BadRequestError("Script schedule has no script command");
    }
    const runId = createScheduleRun(schedule.id, `script:${schedule.id}`);
    try {
      log.info(
        { jobId: schedule.id, name: schedule.name },
        "Executing script schedule manually (run now)",
      );
      const result = await runScript(schedule.script);
      completeScheduleRun(runId, {
        status: result.exitCode === 0 ? "ok" : "error",
        output: result.stdout || undefined,
        error: result.stderr || undefined,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.warn(
        { err, jobId: schedule.id, name: schedule.name },
        "Manual script schedule execution failed",
      );
      completeScheduleRun(runId, { status: "error", error: errorMsg });
    }
    return handleListSchedules({});
  }

  // Check if message is a task invocation (run_task:<task_id>)
  const taskMatch = schedule.message.match(/^run_task:(\S+)$/);
  if (taskMatch) {
    const taskId = taskMatch[1];
    try {
      log.info(
        { jobId: schedule.id, name: schedule.name, taskId },
        "Executing scheduled task manually (run now)",
      );
      const { runTask } = await import("../../tasks/task-runner.js");
      const result = await runTask(
        { taskId, workingDir: process.cwd(), source: "schedule" },
        async (conversationId, message, taskRunId) => {
          const conversation = await getOrCreateConversation(conversationId, {
            trustContext: INTERNAL_GUARDIAN_TRUST_CONTEXT,
          });
          conversation.taskRunId = taskRunId;
          try {
            await conversation.processMessage(
              message,
              [],
              () => {},
              undefined,
              undefined,
              undefined,
              { isInteractive: false },
            );
          } finally {
            conversation.taskRunId = undefined;
          }
        },
      );

      const runId = createScheduleRun(schedule.id, result.conversationId);
      if (result.status === "failed") {
        completeScheduleRun(runId, {
          status: "error",
          error: result.error ?? "Task run failed",
        });
      } else {
        completeScheduleRun(runId, { status: "ok" });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(
        { err, jobId: schedule.id, name: schedule.name, taskId },
        "Manual scheduled task execution failed",
      );
      const fallbackConversation = bootstrapConversation({
        source: "schedule",
        groupId: "system:scheduled",
        origin: "schedule",
        systemHint: `Schedule (manual): ${schedule.name}`,
      });
      const runId = createScheduleRun(schedule.id, fallbackConversation.id);
      completeScheduleRun(runId, { status: "error", error: message });
    }
    return handleListSchedules({});
  }

  // ── Wake mode (resume an existing conversation, no new message) ────
  if (schedule.mode === "wake") {
    if (!schedule.wakeConversationId) {
      throw new BadRequestError("Wake schedule has no target conversation");
    }
    const { wakeAgentForOpportunity } =
      await import("../../runtime/agent-wake.js");
    try {
      await wakeAgentForOpportunity({
        conversationId: schedule.wakeConversationId,
        hint: schedule.message,
        source: "defer",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err, jobId: schedule.id }, "Manual wake execution failed");
      throw new InternalError(message);
    }
    return handleListSchedules({});
  }

  // Regular message-based schedule — respect reuseConversation flag
  const isRecurring = schedule.expression != null;
  let conversationId: string | null = null;
  if (schedule.reuseConversation && isRecurring) {
    const lastId = getLastScheduleConversationId(schedule.id);
    if (lastId && getConversation(lastId)) {
      conversationId = lastId;
    }
  }
  if (!conversationId) {
    const conversation = bootstrapConversation({
      source: "schedule",
      groupId: "system:scheduled",
      origin: "schedule",
      systemHint: `Schedule (manual): ${schedule.name}`,
    });
    conversationId = conversation.id;
  }
  const runId = createScheduleRun(schedule.id, conversationId);

  try {
    log.info(
      {
        jobId: schedule.id,
        name: schedule.name,
        conversationId,
      },
      "Executing schedule manually (run now)",
    );
    const activeConversation = await getOrCreateConversation(conversationId, {
      trustContext: INTERNAL_GUARDIAN_TRUST_CONTEXT,
    });
    activeConversation.taskRunId = undefined;
    await activeConversation.processMessage(
      schedule.message,
      [],
      () => {},
      undefined,
      undefined,
      undefined,
      { isInteractive: false },
    );
    completeScheduleRun(runId, { status: "ok" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(
      { err, jobId: schedule.id, name: schedule.name },
      "Manual schedule execution failed",
    );
    completeScheduleRun(runId, { status: "error", error: message });
  }
  return handleListSchedules({});
}
