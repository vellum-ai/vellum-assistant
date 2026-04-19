/**
 * IPC routes for task template operations.
 *
 * Exposes save/list/run/delete operations so CLI commands and external
 * processes can manage task templates via the daemon IPC socket.
 *
 * Each operation is registered under both a slash-style method name
 * (e.g. `task/save`) and an underscore alias (`task_save`) for ergonomics.
 */

import { z } from "zod";

import { executeTaskDelete } from "../../tools/tasks/task-delete.js";
import { executeTaskList } from "../../tools/tasks/task-list.js";
import { executeTaskRun } from "../../tools/tasks/task-run.js";
import { executeTaskSave } from "../../tools/tasks/task-save.js";
import type { ToolContext } from "../../tools/types.js";
import { getWorkspaceDir } from "../../util/platform.js";
import type { IpcRoute } from "../cli-server.js";

// ── Param schemas ─────────────────────────────────────────────────────

const TaskSaveParams = z.object({
  conversation_id: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
});

const TaskListParams = z.object({}).optional();

const TaskRunParams = z.object({
  task_name: z.string().min(1).optional(),
  task_id: z.string().min(1).optional(),
  inputs: z.record(z.string()).optional(),
});

const TaskDeleteParams = z.object({
  task_ids: z.array(z.string().min(1)).min(1),
});

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Build a minimal ToolContext suitable for IPC callers who don't have
 * implicit conversation context.
 */
function buildIpcToolContext(conversationId?: string): ToolContext {
  return {
    workingDir: getWorkspaceDir(),
    conversationId: conversationId ?? "",
    trustClass: "guardian",
  };
}

// ── Handlers ──────────────────────────────────────────────────────────

async function handleTaskSave(
  params?: Record<string, unknown>,
): Promise<{ ok: boolean; content: string }> {
  const { conversation_id, title } = TaskSaveParams.parse(params);
  const context = buildIpcToolContext(conversation_id);
  const input: Record<string, unknown> = {};
  if (conversation_id) input.conversation_id = conversation_id;
  if (title) input.title = title;

  const result = await executeTaskSave(input, context);

  if (result.isError) {
    throw new Error(result.content);
  }
  return { ok: true, content: result.content };
}

async function handleTaskList(
  _params?: Record<string, unknown>,
): Promise<{ ok: boolean; content: string }> {
  TaskListParams.parse(_params);
  const context = buildIpcToolContext();
  const result = await executeTaskList({}, context);

  if (result.isError) {
    throw new Error(result.content);
  }
  return { ok: true, content: result.content };
}

async function handleTaskRun(
  params?: Record<string, unknown>,
): Promise<{ ok: boolean; content: string }> {
  const { task_name, task_id, inputs } = TaskRunParams.parse(params);
  const context = buildIpcToolContext();
  const input: Record<string, unknown> = {};
  if (task_name) input.task_name = task_name;
  if (task_id) input.task_id = task_id;
  if (inputs) input.inputs = inputs;

  const result = await executeTaskRun(input, context);

  if (result.isError) {
    throw new Error(result.content);
  }
  return { ok: true, content: result.content };
}

async function handleTaskDelete(
  params?: Record<string, unknown>,
): Promise<{ ok: boolean; content: string }> {
  const { task_ids } = TaskDeleteParams.parse(params);
  const context = buildIpcToolContext();
  const result = await executeTaskDelete({ task_ids }, context);

  if (result.isError) {
    throw new Error(result.content);
  }
  return { ok: true, content: result.content };
}

// ── Route definitions ─────────────────────────────────────────────────

export const taskSaveRoute: IpcRoute = {
  method: "task/save",
  handler: handleTaskSave,
};

export const taskSaveAliasRoute: IpcRoute = {
  method: "task_save",
  handler: handleTaskSave,
};

export const taskListRoute: IpcRoute = {
  method: "task/list",
  handler: handleTaskList,
};

export const taskListAliasRoute: IpcRoute = {
  method: "task_list",
  handler: handleTaskList,
};

export const taskRunRoute: IpcRoute = {
  method: "task/run",
  handler: handleTaskRun,
};

export const taskRunAliasRoute: IpcRoute = {
  method: "task_run",
  handler: handleTaskRun,
};

export const taskDeleteRoute: IpcRoute = {
  method: "task/delete",
  handler: handleTaskDelete,
};

export const taskDeleteAliasRoute: IpcRoute = {
  method: "task_delete",
  handler: handleTaskDelete,
};

/** All task template IPC routes (canonical + aliases). */
export const taskTemplateRoutes: IpcRoute[] = [
  taskSaveRoute,
  taskSaveAliasRoute,
  taskListRoute,
  taskListAliasRoute,
  taskRunRoute,
  taskRunAliasRoute,
  taskDeleteRoute,
  taskDeleteAliasRoute,
];
