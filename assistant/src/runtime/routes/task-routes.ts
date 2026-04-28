/**
 * Transport-agnostic routes for task template and task queue (work item)
 * operations.
 */

import { z } from "zod";

import { broadcastToAllClients } from "../../acp/index.js";
import type { ToolContext } from "../../tools/types.js";
import { getWorkspaceDir } from "../../util/platform.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ── Minimal tool context ──────────────────────────────────────────────

function buildToolContext(conversationId?: string): ToolContext {
  return {
    workingDir: getWorkspaceDir(),
    conversationId: conversationId ?? "",
    trustClass: "unknown",
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

// Task template schemas
const TaskSaveParams = z.object({
  conversation_id: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
});

const TaskRunParams = z.object({
  task_name: z.string().min(1).optional(),
  task_id: z.string().min(1).optional(),
  inputs: z.record(z.string(), z.string()).optional(),
});

const TaskDeleteParams = z.object({
  task_ids: z.array(z.string().min(1)).min(1),
});

// Task queue schemas
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

// ── Shared response schema ────────────────────────────────────────────

const ContentResponse = z.object({
  content: z.string(),
  isError: z.boolean().optional(),
});

const OkContentResponse = z.object({
  ok: z.boolean(),
  content: z.string(),
});

// ── Task template handlers ────────────────────────────────────────────

async function handleTaskSave({ body = {} }: RouteHandlerArgs) {
  const { executeTaskSave } = await import(
    "../../tools/tasks/task-save.js"
  );
  const { conversation_id, title } = TaskSaveParams.parse(body);
  const context = buildToolContext(conversation_id);
  const input: Record<string, unknown> = {};
  if (conversation_id) input.conversation_id = conversation_id;
  if (title) input.title = title;

  const result = await executeTaskSave(input, context);
  if (result.isError) {
    throw new BadRequestError(result.content);
  }
  return { ok: true, content: result.content };
}

async function handleTaskList() {
  const { executeTaskList } = await import(
    "../../tools/tasks/task-list.js"
  );
  const context = buildToolContext();
  const result = await executeTaskList({}, context);
  if (result.isError) {
    throw new BadRequestError(result.content);
  }
  return { ok: true, content: result.content };
}

async function handleTaskRun({ body = {} }: RouteHandlerArgs) {
  const { executeTaskRun } = await import(
    "../../tools/tasks/task-run.js"
  );
  const { task_name, task_id, inputs } = TaskRunParams.parse(body);
  const context = buildToolContext();
  const input: Record<string, unknown> = {};
  if (task_name) input.task_name = task_name;
  if (task_id) input.task_id = task_id;
  if (inputs) input.inputs = inputs;

  const result = await executeTaskRun(input, context);
  if (result.isError) {
    throw new BadRequestError(result.content);
  }
  return { ok: true, content: result.content };
}

async function handleTaskDelete({ body = {} }: RouteHandlerArgs) {
  const { executeTaskDelete } = await import(
    "../../tools/tasks/task-delete.js"
  );
  const { task_ids } = TaskDeleteParams.parse(body);
  const context = buildToolContext();
  const result = await executeTaskDelete({ task_ids }, context);
  if (result.isError) {
    throw new BadRequestError(result.content);
  }
  broadcastToAllClients?.({ type: "tasks_changed" });
  return { ok: true, content: result.content };
}

// ── Task queue handlers ───────────────────────────────────────────────

async function handleTaskQueueShow({ body = {} }: RouteHandlerArgs) {
  const { executeTaskListShow } = await import(
    "../../tools/tasks/work-item-list.js"
  );
  const input = TaskQueueShowParams.parse(body);
  const result = await executeTaskListShow(
    input as Record<string, unknown>,
    buildToolContext(),
  );
  return { content: result.content, isError: result.isError };
}

async function handleTaskQueueAdd({ body = {} }: RouteHandlerArgs) {
  const { executeTaskListAdd } = await import(
    "../../tools/tasks/work-item-enqueue.js"
  );
  const input = TaskQueueAddParams.parse(body);
  const result = await executeTaskListAdd(
    input as Record<string, unknown>,
    buildToolContext(),
  );
  if (!result.isError) {
    broadcastToAllClients?.({ type: "tasks_changed" });
  }
  return { content: result.content, isError: result.isError };
}

async function handleTaskQueueUpdate({ body = {} }: RouteHandlerArgs) {
  const { executeTaskListUpdate } = await import(
    "../../tools/tasks/work-item-update.js"
  );
  const input = TaskQueueUpdateParams.parse(body);
  const result = await executeTaskListUpdate(
    input as Record<string, unknown>,
    buildToolContext(),
  );
  if (!result.isError) {
    broadcastToAllClients?.({ type: "tasks_changed" });
  }
  return { content: result.content, isError: result.isError };
}

async function handleTaskQueueRemove({ body = {} }: RouteHandlerArgs) {
  const { executeTaskListRemove } = await import(
    "../../tools/tasks/work-item-remove.js"
  );
  const input = TaskQueueRemoveParams.parse(body);
  const result = await executeTaskListRemove(
    input as Record<string, unknown>,
    buildToolContext(),
  );
  if (!result.isError) {
    broadcastToAllClients?.({ type: "tasks_changed" });
  }
  return { content: result.content, isError: result.isError };
}

async function handleTaskQueueRun({ body = {} }: RouteHandlerArgs) {
  const { executeTaskQueueRun } = await import(
    "../../tools/tasks/work-item-run.js"
  );
  const input = TaskQueueRunParams.parse(body);
  const result = await executeTaskQueueRun(
    input as Record<string, unknown>,
    buildToolContext(),
  );
  if (!result.isError) {
    broadcastToAllClients?.({ type: "tasks_changed" });
  }
  return { content: result.content, isError: result.isError };
}

// ── Route definitions ─────────────────────────────────────────────────

export const ROUTES: RouteDefinition[] = [
  // ── Task templates ──────────────────────────────────────────────────
  {
    operationId: "task_save",
    endpoint: "tasks/save",
    method: "POST",
    handler: handleTaskSave,
    summary: "Save a task template",
    description: "Save the current conversation as a reusable task template.",
    tags: ["tasks"],
    requestBody: TaskSaveParams,
    responseBody: OkContentResponse,
  },
  {
    operationId: "task_list",
    endpoint: "tasks/list",
    method: "POST",
    handler: handleTaskList,
    summary: "List task templates",
    description: "List all saved task templates.",
    tags: ["tasks"],
    responseBody: OkContentResponse,
  },
  {
    operationId: "task_run",
    endpoint: "tasks/run",
    method: "POST",
    handler: handleTaskRun,
    summary: "Run a task template",
    description: "Execute a saved task template by name or ID.",
    tags: ["tasks"],
    requestBody: TaskRunParams,
    responseBody: OkContentResponse,
  },
  {
    operationId: "task_delete",
    endpoint: "tasks/delete",
    method: "POST",
    handler: handleTaskDelete,
    summary: "Delete task templates",
    description: "Delete one or more task templates by ID.",
    tags: ["tasks"],
    requestBody: TaskDeleteParams,
    responseBody: OkContentResponse,
  },

  // ── Task queue (work items) ─────────────────────────────────────────
  {
    operationId: "task_queue_show",
    endpoint: "tasks/queue/show",
    method: "POST",
    handler: handleTaskQueueShow,
    summary: "Show task queue",
    description: "List work items in the task queue, optionally filtered by status.",
    tags: ["tasks"],
    requestBody: TaskQueueShowParams,
    responseBody: ContentResponse,
  },
  {
    operationId: "task_queue_add",
    endpoint: "tasks/queue/add",
    method: "POST",
    handler: handleTaskQueueAdd,
    summary: "Add to task queue",
    description: "Add a new work item to the task queue.",
    tags: ["tasks"],
    requestBody: TaskQueueAddParams,
    responseBody: ContentResponse,
  },
  {
    operationId: "task_queue_update",
    endpoint: "tasks/queue/update",
    method: "POST",
    handler: handleTaskQueueUpdate,
    summary: "Update a task queue item",
    description: "Update an existing work item in the task queue.",
    tags: ["tasks"],
    requestBody: TaskQueueUpdateParams,
    responseBody: ContentResponse,
  },
  {
    operationId: "task_queue_remove",
    endpoint: "tasks/queue/remove",
    method: "POST",
    handler: handleTaskQueueRemove,
    summary: "Remove from task queue",
    description: "Remove a work item from the task queue.",
    tags: ["tasks"],
    requestBody: TaskQueueRemoveParams,
    responseBody: ContentResponse,
  },
  {
    operationId: "task_queue_run",
    endpoint: "tasks/queue/run",
    method: "POST",
    handler: handleTaskQueueRun,
    summary: "Run next task queue item",
    description: "Pick up and execute the next work item from the queue.",
    tags: ["tasks"],
    requestBody: TaskQueueRunParams,
    responseBody: ContentResponse,
  },
];
