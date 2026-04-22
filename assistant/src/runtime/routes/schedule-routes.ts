/**
 * HTTP route handlers for schedule management.
 *
 * HTTP route handlers for schedule management.
 */

import { z } from "zod";

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
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";
import type { SendMessageDeps } from "../http-types.js";

const log = getLogger("schedule-routes");
const SCHEDULE_GUARDIAN_TRUST_CONTEXT = {
  sourceChannel: "vellum",
  trustClass: "guardian",
} as const;

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
      script: j.script,
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
      reuseConversation: j.reuseConversation,
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

const VALID_MODES = ["notify", "execute", "script"] as const;
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
    "script",
    "mode",
    "routingIntent",
    "quiet",
    "reuseConversation",
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

function handleListScheduleRuns(id: string, limit: number): Response {
  const schedule = getSchedule(id);
  if (!schedule) {
    return httpError("NOT_FOUND", "Schedule not found", 404);
  }
  const runs = getScheduleRuns(id, limit);
  return Response.json({
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
  });
}

async function handleRunScheduleNow(
  id: string,
  sendMessageDeps?: SendMessageDeps,
): Promise<Response> {
  const schedule = getSchedule(id);
  if (!schedule) {
    return httpError("NOT_FOUND", "Schedule not found", 404);
  }

  // ── Script mode (shell command, no LLM) ──────────────────────────
  if (schedule.mode === "script") {
    if (!schedule.script) {
      return httpError(
        "BAD_REQUEST",
        "Script schedule has no script command",
        400,
      );
    }
    const runId = createScheduleRun(schedule.id, `script:${schedule.id}`);
    try {
      log.info(
        { jobId: schedule.id, name: schedule.name },
        "Executing script schedule manually via HTTP (run now)",
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
    return handleListSchedules();
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
          const conversation = await sendMessageDeps.getOrCreateConversation(
            conversationId,
            {
              trustContext: SCHEDULE_GUARDIAN_TRUST_CONTEXT,
            },
          );
          conversation.taskRunId = taskRunId;
          try {
            await conversation.processMessage(
              message,
              [],
              () => {}, // no event callback for HTTP mode
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
    return handleListSchedules();
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
      "Executing schedule manually via HTTP (run now)",
    );
    if (!sendMessageDeps) {
      throw new Error("sendMessageDeps not available for schedule execution");
    }
    const activeConversation = await sendMessageDeps.getOrCreateConversation(
      conversationId,
      {
        trustContext: SCHEDULE_GUARDIAN_TRUST_CONTEXT,
      },
    );
    activeConversation.taskRunId = undefined;
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
      responseBody: z.object({
        schedules: z.array(z.unknown()).describe("Schedule objects"),
      }),
      handler: () => handleListSchedules(),
    },
    {
      endpoint: "schedules/:id/runs",
      method: "GET",
      policyKey: "schedules",
      summary: "List schedule runs",
      description: "Return recent invocation history for a schedule.",
      tags: ["schedules"],
      responseBody: z.object({
        runs: z.array(z.unknown()).describe("Schedule run objects"),
      }),
      handler: ({ params, url }) => {
        const limitParam = url.searchParams.get("limit");
        const limit = limitParam ? Math.min(Number(limitParam), 100) : 10;
        return handleListScheduleRuns(params.id, limit);
      },
    },
    {
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
      responseBody: z.object({
        schedules: z.array(z.unknown()).describe("Updated schedule list"),
      }),
      handler: ({ params }) => handleDeleteSchedule(params.id),
    },
    {
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
      }),
      responseBody: z.object({
        schedules: z.array(z.unknown()).describe("Updated schedule list"),
      }),
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
      responseBody: z.object({
        schedules: z.array(z.unknown()).describe("Updated schedule list"),
      }),
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
      responseBody: z.object({
        schedules: z.array(z.unknown()).describe("Updated schedule list"),
      }),
      handler: ({ params }) => handleCancelSchedule(params.id),
    },
  ];
}
