/**
 * IPC routes for task queue (work item) operations.
 *
 * Exposes show/add/update/remove/run operations so CLI commands and external
 * processes can interact with the task queue over the Unix domain socket.
 *
 * Each operation is registered under both a slash-style method name
 * (e.g. `task/queue/show`) and an underscore alias (`task_queue_show`).
 */

import { z } from "zod";

import { broadcastToAllClients } from "../../acp/index.js";
import type { ToolContext } from "../../tools/types.js";
import { getWorkspaceDir } from "../../util/platform.js";
import type { IpcRoute } from "../assistant-server.js";

// ── Minimal tool context ──────────────────────────────────────────────

/**
 * Build a minimal ToolContext for queue operations.
 * Queue operations don't use the context (all execute functions ignore it),
 * but the type signature requires it.
 */
function queueToolContext(): ToolContext {
  return {
    workingDir: getWorkspaceDir(),
    conversationId: "",
    trustClass: "guardian",
  };
}

// ── Param schemas ─────────────────────────────────────────────────────

const WORK_ITEM_STATUSES = [
  "queued",
  "running",
  "awaiting_review",
  "done",
  "failed",
  "cancelled",
  "archived",
] as const;

const TaskQueueShowParams = z.object({
  status: z.union([z.string(), z.array(z.string())]).optional(),
});

const TaskQueueAddParams = z.object({
  task_id: z.string().optional(),
  task_name: z.string().optional(),
  title: z.string().optional(),
  execution_prompt: z.string().optional(),
  notes: z.string().optional(),
  priority_tier: z.number().optional(),
  sort_index: z.number().optional(),
  if_exists: z
    .enum(["create_duplicate", "reuse_existing", "update_existing"])
    .optional(),
  required_tools: z.array(z.string()).optional(),
});

const TaskQueueUpdateParams = z.object({
  work_item_id: z.string().optional(),
  task_id: z.string().optional(),
  task_name: z.string().optional(),
  title: z.string().optional(),
  priority_tier: z.number().optional(),
  notes: z.string().optional(),
  status: z.enum(WORK_ITEM_STATUSES).optional(),
  sort_index: z.number().optional(),
  filter_priority_tier: z.number().optional(),
  filter_status: z.string().optional(),
  created_order: z.number().optional(),
});

const TaskQueueRemoveParams = z.object({
  work_item_id: z.string().optional(),
  task_id: z.string().optional(),
  task_name: z.string().optional(),
  title: z.string().optional(),
  priority_tier: z.number().optional(),
  status: z.string().optional(),
  created_order: z.number().optional(),
});

const TaskQueueRunParams = z.object({
  work_item_id: z.string().optional(),
  task_name: z.string().optional(),
  title: z.string().optional(),
});

// ── Handlers ──────────────────────────────────────────────────────────

async function handleTaskQueueShow(params?: Record<string, unknown>) {
  const { executeTaskListShow } =
    await import("../../tools/tasks/work-item-list.js");
  const input = TaskQueueShowParams.parse(params ?? {});
  const result = await executeTaskListShow(
    input as Record<string, unknown>,
    queueToolContext(),
  );
  return { content: result.content, isError: result.isError };
}

async function handleTaskQueueAdd(params?: Record<string, unknown>) {
  const { executeTaskListAdd } =
    await import("../../tools/tasks/work-item-enqueue.js");
  const input = TaskQueueAddParams.parse(params ?? {});
  const result = await executeTaskListAdd(
    input as Record<string, unknown>,
    queueToolContext(),
  );
  if (!result.isError) {
    broadcastToAllClients?.({ type: "tasks_changed" });
  }
  return { content: result.content, isError: result.isError };
}

async function handleTaskQueueUpdate(params?: Record<string, unknown>) {
  const { executeTaskListUpdate } =
    await import("../../tools/tasks/work-item-update.js");
  const input = TaskQueueUpdateParams.parse(params ?? {});
  const result = await executeTaskListUpdate(
    input as Record<string, unknown>,
    queueToolContext(),
  );
  if (!result.isError) {
    broadcastToAllClients?.({ type: "tasks_changed" });
  }
  return { content: result.content, isError: result.isError };
}

async function handleTaskQueueRemove(params?: Record<string, unknown>) {
  const { executeTaskListRemove } =
    await import("../../tools/tasks/work-item-remove.js");
  const input = TaskQueueRemoveParams.parse(params ?? {});
  const result = await executeTaskListRemove(
    input as Record<string, unknown>,
    queueToolContext(),
  );
  if (!result.isError) {
    broadcastToAllClients?.({ type: "tasks_changed" });
  }
  return { content: result.content, isError: result.isError };
}

async function handleTaskQueueRun(params?: Record<string, unknown>) {
  const { executeTaskQueueRun } =
    await import("../../tools/tasks/work-item-run.js");
  const input = TaskQueueRunParams.parse(params ?? {});
  const result = await executeTaskQueueRun(
    input as Record<string, unknown>,
    queueToolContext(),
  );
  if (!result.isError) {
    broadcastToAllClients?.({ type: "tasks_changed" });
  }
  return { content: result.content, isError: result.isError };
}

// ── Route definitions ─────────────────────────────────────────────────

export const taskQueueShowRoute: IpcRoute = {
  method: "task/queue/show",
  handler: handleTaskQueueShow,
};

const taskQueueShowAliasRoute: IpcRoute = {
  method: "task_queue_show",
  handler: handleTaskQueueShow,
};

export const taskQueueAddRoute: IpcRoute = {
  method: "task/queue/add",
  handler: handleTaskQueueAdd,
};

const taskQueueAddAliasRoute: IpcRoute = {
  method: "task_queue_add",
  handler: handleTaskQueueAdd,
};

export const taskQueueUpdateRoute: IpcRoute = {
  method: "task/queue/update",
  handler: handleTaskQueueUpdate,
};

const taskQueueUpdateAliasRoute: IpcRoute = {
  method: "task_queue_update",
  handler: handleTaskQueueUpdate,
};

export const taskQueueRemoveRoute: IpcRoute = {
  method: "task/queue/remove",
  handler: handleTaskQueueRemove,
};

const taskQueueRemoveAliasRoute: IpcRoute = {
  method: "task_queue_remove",
  handler: handleTaskQueueRemove,
};

export const taskQueueRunRoute: IpcRoute = {
  method: "task/queue/run",
  handler: handleTaskQueueRun,
};

const taskQueueRunAliasRoute: IpcRoute = {
  method: "task_queue_run",
  handler: handleTaskQueueRun,
};

/** All task queue IPC routes (canonical + aliases). */
export const taskQueueRoutes: IpcRoute[] = [
  taskQueueShowRoute,
  taskQueueShowAliasRoute,
  taskQueueAddRoute,
  taskQueueAddAliasRoute,
  taskQueueUpdateRoute,
  taskQueueUpdateAliasRoute,
  taskQueueRemoveRoute,
  taskQueueRemoveAliasRoute,
  taskQueueRunRoute,
  taskQueueRunAliasRoute,
];
