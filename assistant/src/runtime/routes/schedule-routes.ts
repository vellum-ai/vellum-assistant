/**
 * HTTP route handlers for schedule management.
 *
 * Migrated from IPC handler: handlers/config-scheduling.ts
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
import {
  cancelReminder,
  listReminders,
} from "../../tools/reminder/reminder-store.js";
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
      return httpError("NOT_FOUND", "Schedule not found or not cancellable", 404);
    }
    log.info({ id }, "Schedule cancelled via HTTP");
  } catch (err) {
    log.error({ err }, "Failed to cancel schedule");
    return httpError("INTERNAL_ERROR", "Failed to cancel schedule", 500);
  }
  return handleListSchedules();
}

/**
 * List reminders by querying one-shot schedules from the schedule store,
 * falling back to the legacy reminder store for entries not yet migrated.
 */
function handleListReminders(): Response {
  // Query one-shot schedules and map to RemindersListResponse shape
  const oneShotSchedules = listSchedules({ oneShotOnly: true });
  const fromSchedules = oneShotSchedules.map((s) => ({
    id: s.id,
    label: s.name,
    message: s.message,
    fireAt: s.nextRunAt,
    mode: s.mode,
    status: mapScheduleStatusToReminderStatus(s.status),
    firedAt: s.lastRunAt,
    createdAt: s.createdAt,
  }));

  // Fall back to legacy reminder store for entries not yet migrated
  const legacyReminders = listReminders();
  const scheduleIds = new Set(fromSchedules.map((r) => r.id));
  const fromLegacy = legacyReminders
    .filter((r) => !scheduleIds.has(r.id))
    .map((r) => ({
      id: r.id,
      label: r.label,
      message: r.message,
      fireAt: r.fireAt,
      mode: r.mode,
      status: r.status,
      firedAt: r.firedAt,
      createdAt: r.createdAt,
    }));

  return Response.json({
    type: "reminders_list_response",
    reminders: [...fromSchedules, ...fromLegacy],
  });
}

/**
 * Cancel a reminder by first trying the schedule store (one-shot schedules),
 * then falling back to the legacy reminder store.
 */
function handleCancelReminder(id: string): Response {
  // Try schedule store first
  const cancelledSchedule = cancelSchedule(id);
  if (cancelledSchedule) {
    log.info({ id }, "Reminder cancelled via schedule store");
    return handleListReminders();
  }

  // Fall back to legacy reminder store
  const cancelledReminder = cancelReminder(id);
  if (cancelledReminder) {
    log.info({ id }, "Reminder cancelled via legacy reminder store");
    return handleListReminders();
  }

  return httpError("NOT_FOUND", "Reminder not found", 404);
}

/**
 * Map schedule status values to legacy reminder status values for client compat.
 */
function mapScheduleStatusToReminderStatus(status: string): string {
  switch (status) {
    case "active":
      return "pending";
    case "firing":
      return "firing";
    case "fired":
      return "fired";
    case "cancelled":
      return "cancelled";
    default:
      return status;
  }
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
            throw new Error("sendMessageDeps not available for schedule execution");
          }
          const session = await sendMessageDeps.getOrCreateSession(
            conversationId,
          );
          session.taskRunId = taskRunId;
          await session.processMessage(
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
    const session = await sendMessageDeps.getOrCreateSession(conversation.id);
    await session.processMessage(
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
      handler: () => handleListSchedules(),
    },
    {
      endpoint: "schedules/:id/toggle",
      method: "POST",
      policyKey: "schedules/toggle",
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
      handler: ({ params }) => handleDeleteSchedule(params.id),
    },
    {
      endpoint: "schedules/:id/run",
      method: "POST",
      policyKey: "schedules/run",
      handler: async ({ params }) =>
        handleRunScheduleNow(params.id, deps.sendMessageDeps),
    },
    {
      endpoint: "schedules/:id/cancel",
      method: "POST",
      policyKey: "schedules",
      handler: ({ params }) => handleCancelSchedule(params.id),
    },
    // Reminder-compat routes: serve reminders from schedule store
    {
      endpoint: "reminders",
      method: "GET",
      policyKey: "schedules",
      handler: () => handleListReminders(),
    },
    {
      endpoint: "reminders/:id/cancel",
      method: "POST",
      policyKey: "schedules",
      handler: ({ params }) => handleCancelReminder(params.id),
    },
  ];
}
