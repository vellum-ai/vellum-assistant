/**
 * HTTP route handlers for schedule management.
 *
 * HTTP route handlers for schedule management.
 */

import { bootstrapConversation } from "../../memory/conversation-bootstrap.js";
import {
  cancelSchedule,
  completeScheduleRun,
  createScheduleRun,
  deleteSchedule,
  describeCronExpression,
  getSchedule,
  listSchedules,
  updateSchedule,
} from "../../schedule/schedule-store.js";
import { getLogger } from "../../util/logger.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";
import type { SendMessageDeps } from "../http-types.js";

const log = getLogger("schedule-routes");

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleListSchedules(): Response {
  const jobs = listSchedules();
  return Response.json({
    schedules: jobs.map((j) => ({
      id: j.id,
      name: j.name,
      enabled: j.enabled,
      syntax: j.syntax,
      expression: j.expression,
      cronExpression: j.cronExpression,
      timezone: j.timezone,
      message: j.message,
      nextRunAt: j.nextRunAt,
      lastRunAt: j.lastRunAt,
      lastStatus: j.lastStatus,
      description:
        j.syntax === "cron"
          ? describeCronExpression(j.cronExpression)
          : j.expression,
      mode: j.mode,
      status: j.status,
      routingIntent: j.routingIntent,
      isOneShot: j.cronExpression == null,
    })),
  });
}

function handleToggleSchedule(id: string, enabled: boolean): Response {
  try {
    const updated = updateSchedule(id, { enabled });
    if (!updated) {
      return httpError("NOT_FOUND", "Schedule not found", 404);
    }
    log.info({ id, enabled }, "Schedule toggled via HTTP");
  } catch (err) {
    log.error({ err }, "Failed to toggle schedule");
    return httpError("INTERNAL_ERROR", "Failed to toggle schedule", 500);
  }
  return handleListSchedules();
}

function handleDeleteSchedule(id: string): Response {
  try {
    const removed = deleteSchedule(id);
    if (!removed) {
      return httpError("NOT_FOUND", "Schedule not found", 404);
    }
    log.info({ id }, "Schedule removed via HTTP");
  } catch (err) {
    log.error({ err }, "Failed to remove schedule");
    return httpError("INTERNAL_ERROR", "Failed to remove schedule", 500);
  }
  return handleListSchedules();
}

function handleCancelSchedule(id: string): Response {
  try {
    const cancelled = cancelSchedule(id);
    if (!cancelled) {
      return httpError(
        "NOT_FOUND",
        "Schedule not found or not cancellable",
        404,
      );
    }
    log.info({ id }, "Schedule cancelled via HTTP");
  } catch (err) {
    log.error({ err }, "Failed to cancel schedule");
    return httpError("INTERNAL_ERROR", "Failed to cancel schedule", 500);
  }
  return handleListSchedules();
}

const VALID_MODES = ["notify", "execute"] as const;
const VALID_ROUTING_INTENTS = [
  "single_channel",
  "multi_channel",
  "all_channels",
] as const;

function handleUpdateSchedule(
  id: string,
  body: Record<string, unknown>,
): Response {
  const updates: Record<string, unknown> = {};

  if (
    "mode" in body &&
    !VALID_MODES.includes(body.mode as (typeof VALID_MODES)[number])
  ) {
    return httpError(
      "BAD_REQUEST",
      `Invalid mode: must be one of ${VALID_MODES.join(", ")}`,
      400,
    );
  }
  if (
    "routingIntent" in body &&
    !VALID_ROUTING_INTENTS.includes(
      body.routingIntent as (typeof VALID_ROUTING_INTENTS)[number],
    )
  ) {
    return httpError(
      "BAD_REQUEST",
      `Invalid routingIntent: must be one of ${VALID_ROUTING_INTENTS.join(", ")}`,
      400,
    );
  }

  for (const key of [
    "name",
    "expression",
    "timezone",
    "message",
    "mode",
    "routingIntent",
    "quiet",
  ] as const) {
    if (key in body) {
      updates[key] = body[key];
    }
  }

  try {
    const updated = updateSchedule(id, updates);
    if (!updated) {
      return httpError("NOT_FOUND", "Schedule not found", 404);
    }
    log.info({ id, updates }, "Schedule updated via HTTP");
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message.includes("Invalid") || err.message.includes("invalid"))
    ) {
      return httpError("BAD_REQUEST", err.message, 400);
    }
    log.error({ err }, "Failed to update schedule");
    return httpError("INTERNAL_ERROR", "Failed to update schedule", 500);
  }
  return handleListSchedules();
}

async function handleRunScheduleNow(
  id: string,
  sendMessageDeps?: SendMessageDeps,
): Promise<Response> {
  const schedule = getSchedule(id);
  if (!schedule) {
    return httpError("NOT_FOUND", "Schedule not found", 404);
  }

  // Check if message is a task invocation (run_task:<task_id>)
  const taskMatch = schedule.message.match(/^run_task:(\S+)$/);
  if (taskMatch) {
    const taskId = taskMatch[1];
    try {
      log.info(
        { jobId: schedule.id, name: schedule.name, taskId },
        "Executing scheduled task manually via HTTP (run now)",
      );
      const { runTask } = await import("../../tasks/task-runner.js");
      const result = await runTask(
        { taskId, workingDir: process.cwd(), source: "schedule" },
        async (conversationId, message, taskRunId) => {
          if (!sendMessageDeps) {
            throw new Error(
              "sendMessageDeps not available for schedule execution",
            );
          }
          const conversation =
            await sendMessageDeps.getOrCreateConversation(conversationId);
          conversation.taskRunId = taskRunId;
          await conversation.processMessage(
            message,
            [],
            () => {}, // no event callback for HTTP mode
            undefined,
            undefined,
            undefined,
            { isInteractive: false },
          );
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
        origin: "schedule",
        systemHint: `Schedule (manual): ${schedule.name}`,
      });
      const runId = createScheduleRun(schedule.id, fallbackConversation.id);
      completeScheduleRun(runId, { status: "error", error: message });
    }
    return handleListSchedules();
  }

  // Regular message-based schedule
  const conversation = bootstrapConversation({
    source: "schedule",
    origin: "schedule",
    systemHint: `Schedule (manual): ${schedule.name}`,
  });
  const runId = createScheduleRun(schedule.id, conversation.id);

  try {
    log.info(
      {
        jobId: schedule.id,
        name: schedule.name,
        conversationId: conversation.id,
      },
      "Executing schedule manually via HTTP (run now)",
    );
    if (!sendMessageDeps) {
      throw new Error("sendMessageDeps not available for schedule execution");
    }
    const activeConversation = await sendMessageDeps.getOrCreateConversation(
      conversation.id,
    );
    await activeConversation.processMessage(
      schedule.message,
      [],
      () => {}, // no event callback for HTTP mode
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
  return handleListSchedules();
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function scheduleRouteDefinitions(deps: {
  sendMessageDeps?: SendMessageDeps;
}): RouteDefinition[] {
  return [
    {
      endpoint: "schedules",
      method: "GET",
      policyKey: "schedules",
      summary: "List schedules",
      description: "Return all scheduled jobs.",
      tags: ["schedules"],
      responseBody: {
        type: "object",
        properties: {
          schedules: { type: "array", description: "Schedule objects" },
        },
      },
      handler: () => handleListSchedules(),
    },
    {
      endpoint: "schedules/:id/toggle",
      method: "POST",
      policyKey: "schedules/toggle",
      summary: "Toggle schedule",
      description: "Enable or disable a schedule.",
      tags: ["schedules"],
      requestBody: {
        type: "object",
        properties: {
          enabled: { type: "boolean", description: "New enabled state" },
        },
        required: ["enabled"],
      },
      responseBody: {
        type: "object",
        properties: {
          schedules: { type: "array", description: "Updated schedule list" },
        },
      },
      handler: async ({ req, params }) => {
        const body = (await req.json()) as { enabled?: boolean };
        if (body.enabled === undefined) {
          return httpError("BAD_REQUEST", "enabled is required", 400);
        }
        return handleToggleSchedule(params.id, body.enabled);
      },
    },
    {
      endpoint: "schedules/:id",
      method: "DELETE",
      policyKey: "schedules",
      summary: "Delete schedule",
      description: "Remove a schedule by ID.",
      tags: ["schedules"],
      responseBody: {
        type: "object",
        properties: {
          schedules: { type: "array", description: "Updated schedule list" },
        },
      },
      handler: ({ params }) => handleDeleteSchedule(params.id),
    },
    {
      endpoint: "schedules/:id",
      method: "PATCH",
      policyKey: "schedules",
      summary: "Update schedule",
      description: "Partially update fields on a schedule.",
      tags: ["schedules"],
      requestBody: {
        type: "object",
        properties: {
          name: { type: "string" },
          expression: { type: "string" },
          timezone: { type: "string" },
          message: { type: "string" },
          mode: { type: "string", description: "notify or execute" },
          routingIntent: {
            type: "string",
            description: "single_channel, multi_channel, or all_channels",
          },
          quiet: { type: "boolean" },
        },
      },
      responseBody: {
        type: "object",
        properties: {
          schedules: { type: "array", description: "Updated schedule list" },
        },
      },
      handler: async ({ req, params }) => {
        const body: unknown = await req.json();
        if (typeof body !== "object" || !body || Array.isArray(body)) {
          return httpError(
            "BAD_REQUEST",
            "Request body must be a JSON object",
            400,
          );
        }
        return handleUpdateSchedule(params.id, body as Record<string, unknown>);
      },
    },
    {
      endpoint: "schedules/:id/run",
      method: "POST",
      policyKey: "schedules/run",
      summary: "Run schedule now",
      description: "Trigger an immediate execution of a schedule.",
      tags: ["schedules"],
      responseBody: {
        type: "object",
        properties: {
          schedules: { type: "array", description: "Updated schedule list" },
        },
      },
      handler: async ({ params }) =>
        handleRunScheduleNow(params.id, deps.sendMessageDeps),
    },
    {
      endpoint: "schedules/:id/cancel",
      method: "POST",
      policyKey: "schedules/cancel",
      summary: "Cancel schedule",
      description: "Cancel a pending schedule.",
      tags: ["schedules"],
      responseBody: {
        type: "object",
        properties: {
          schedules: { type: "array", description: "Updated schedule list" },
        },
      },
      handler: ({ params }) => handleCancelSchedule(params.id),
    },
  ];
}
