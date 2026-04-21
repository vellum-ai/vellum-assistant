/**
 * Tests for the task template and task queue IPC routes.
 *
 * Mocks the execute functions at the module boundary so route handlers
 * can be exercised without real task/queue state.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import type { ToolExecutionResult } from "../../tools/types.js";

// ---------------------------------------------------------------------------
// Mock state — task template operations
// ---------------------------------------------------------------------------

let mockTaskSaveResult: ToolExecutionResult = {
  content: "ok",
  isError: false,
};
let mockTaskSaveCalls: Array<{
  input: Record<string, unknown>;
  context: { conversationId: string };
}> = [];

let mockTaskListResult: ToolExecutionResult = {
  content: "ok",
  isError: false,
};
let mockTaskListCalls: Array<{
  input: Record<string, unknown>;
  context: { conversationId: string };
}> = [];

let mockTaskRunResult: ToolExecutionResult = {
  content: "ok",
  isError: false,
};
let mockTaskRunCalls: Array<{
  input: Record<string, unknown>;
  context: { conversationId: string };
}> = [];

let mockTaskDeleteResult: ToolExecutionResult = {
  content: "ok",
  isError: false,
};
let mockTaskDeleteCalls: Array<{
  input: Record<string, unknown>;
  context: { conversationId: string };
}> = [];

// Mock state — task queue operations

let mockWorkItemListResult: ToolExecutionResult = {
  content: "ok",
  isError: false,
};
let mockWorkItemListCalls: Array<{
  input: Record<string, unknown>;
  context: { conversationId: string };
}> = [];

let mockWorkItemEnqueueResult: ToolExecutionResult = {
  content: "ok",
  isError: false,
};
let mockWorkItemEnqueueCalls: Array<{
  input: Record<string, unknown>;
  context: { conversationId: string };
}> = [];

let mockWorkItemUpdateResult: ToolExecutionResult = {
  content: "ok",
  isError: false,
};
let mockWorkItemUpdateCalls: Array<{
  input: Record<string, unknown>;
  context: { conversationId: string };
}> = [];

let mockWorkItemRemoveResult: ToolExecutionResult = {
  content: "ok",
  isError: false,
};
let mockWorkItemRemoveCalls: Array<{
  input: Record<string, unknown>;
  context: { conversationId: string };
}> = [];

let mockWorkItemRunResult: ToolExecutionResult = {
  content: "ok",
  isError: false,
};
let mockWorkItemRunCalls: Array<{
  input: Record<string, unknown>;
  context: { conversationId: string };
}> = [];

// ---------------------------------------------------------------------------
// Module mocks — task template execute functions
// ---------------------------------------------------------------------------

mock.module("../../tools/tasks/task-save.js", () => ({
  executeTaskSave: async (
    input: Record<string, unknown>,
    context: { conversationId: string },
  ) => {
    mockTaskSaveCalls.push({ input, context });
    return mockTaskSaveResult;
  },
}));

mock.module("../../tools/tasks/task-list.js", () => ({
  executeTaskList: async (
    input: Record<string, unknown>,
    context: { conversationId: string },
  ) => {
    mockTaskListCalls.push({ input, context });
    return mockTaskListResult;
  },
}));

mock.module("../../tools/tasks/task-run.js", () => ({
  executeTaskRun: async (
    input: Record<string, unknown>,
    context: { conversationId: string },
  ) => {
    mockTaskRunCalls.push({ input, context });
    return mockTaskRunResult;
  },
}));

mock.module("../../tools/tasks/task-delete.js", () => ({
  executeTaskDelete: async (
    input: Record<string, unknown>,
    context: { conversationId: string },
  ) => {
    mockTaskDeleteCalls.push({ input, context });
    return mockTaskDeleteResult;
  },
}));

// ---------------------------------------------------------------------------
// Module mocks — task queue execute functions
// ---------------------------------------------------------------------------

mock.module("../../tools/tasks/work-item-list.js", () => ({
  executeTaskListShow: async (
    input: Record<string, unknown>,
    context: { conversationId: string },
  ) => {
    mockWorkItemListCalls.push({ input, context });
    return mockWorkItemListResult;
  },
}));

mock.module("../../tools/tasks/work-item-enqueue.js", () => ({
  executeTaskListAdd: async (
    input: Record<string, unknown>,
    context: { conversationId: string },
  ) => {
    mockWorkItemEnqueueCalls.push({ input, context });
    return mockWorkItemEnqueueResult;
  },
}));

mock.module("../../tools/tasks/work-item-update.js", () => ({
  executeTaskListUpdate: async (
    input: Record<string, unknown>,
    context: { conversationId: string },
  ) => {
    mockWorkItemUpdateCalls.push({ input, context });
    return mockWorkItemUpdateResult;
  },
}));

mock.module("../../tools/tasks/work-item-remove.js", () => ({
  executeTaskListRemove: async (
    input: Record<string, unknown>,
    context: { conversationId: string },
  ) => {
    mockWorkItemRemoveCalls.push({ input, context });
    return mockWorkItemRemoveResult;
  },
}));

mock.module("../../tools/tasks/work-item-run.js", () => ({
  executeTaskQueueRun: async (
    input: Record<string, unknown>,
    context: { conversationId: string },
  ) => {
    mockWorkItemRunCalls.push({ input, context });
    return mockWorkItemRunResult;
  },
}));

// Also mock getWorkspaceDir so task.ts doesn't hit the real filesystem
mock.module("../../util/platform.js", () => ({
  getWorkspaceDir: () => "/mock/workspace",
}));

// ---------------------------------------------------------------------------
// Import route handlers after mocking
// ---------------------------------------------------------------------------

const { taskSaveRoute, taskListRoute, taskRunRoute, taskDeleteRoute } =
  await import("../routes/task.js");

const {
  taskQueueShowRoute,
  taskQueueAddRoute,
  taskQueueUpdateRoute,
  taskQueueRemoveRoute,
  taskQueueRunRoute,
} = await import("../routes/task-queue.js");

// ---------------------------------------------------------------------------
// Reset helpers
// ---------------------------------------------------------------------------

afterEach(() => {
  mockTaskSaveResult = { content: "ok", isError: false };
  mockTaskSaveCalls = [];
  mockTaskListResult = { content: "ok", isError: false };
  mockTaskListCalls = [];
  mockTaskRunResult = { content: "ok", isError: false };
  mockTaskRunCalls = [];
  mockTaskDeleteResult = { content: "ok", isError: false };
  mockTaskDeleteCalls = [];

  mockWorkItemListResult = { content: "ok", isError: false };
  mockWorkItemListCalls = [];
  mockWorkItemEnqueueResult = { content: "ok", isError: false };
  mockWorkItemEnqueueCalls = [];
  mockWorkItemUpdateResult = { content: "ok", isError: false };
  mockWorkItemUpdateCalls = [];
  mockWorkItemRemoveResult = { content: "ok", isError: false };
  mockWorkItemRemoveCalls = [];
  mockWorkItemRunResult = { content: "ok", isError: false };
  mockWorkItemRunCalls = [];
});

// ===========================================================================
// Task template routes
// ===========================================================================

describe("task/save IPC route", () => {
  test("method is task/save", () => {
    expect(taskSaveRoute.method).toBe("task/save");
  });

  test("delegates to executeTaskSave with correct conversationId", async () => {
    mockTaskSaveResult = { content: "Task saved", isError: false };

    const result = await taskSaveRoute.handler({
      conversation_id: "conv-123",
      title: "My Task",
    });

    expect(result).toEqual({ ok: true, content: "Task saved" });
    expect(mockTaskSaveCalls).toHaveLength(1);
    expect(mockTaskSaveCalls[0].input).toEqual({
      conversation_id: "conv-123",
      title: "My Task",
    });
    expect(mockTaskSaveCalls[0].context.conversationId).toBe("conv-123");
  });

  test("passes empty conversationId when conversation_id is omitted", async () => {
    await taskSaveRoute.handler({});

    expect(mockTaskSaveCalls).toHaveLength(1);
    expect(mockTaskSaveCalls[0].context.conversationId).toBe("");
  });

  test("throws when executeTaskSave returns isError: true", async () => {
    mockTaskSaveResult = { content: "Save failed", isError: true };

    await expect(
      taskSaveRoute.handler({ conversation_id: "conv-1" }),
    ).rejects.toThrow("Save failed");
  });
});

describe("task/list IPC route", () => {
  test("method is task/list", () => {
    expect(taskListRoute.method).toBe("task/list");
  });

  test("delegates to executeTaskList with no params", async () => {
    mockTaskListResult = {
      content: "task1\ntask2",
      isError: false,
    };

    const result = await taskListRoute.handler();

    expect(result).toEqual({ ok: true, content: "task1\ntask2" });
    expect(mockTaskListCalls).toHaveLength(1);
    expect(mockTaskListCalls[0].input).toEqual({});
  });

  test("throws when executeTaskList returns isError: true", async () => {
    mockTaskListResult = { content: "List failed", isError: true };

    await expect(taskListRoute.handler()).rejects.toThrow("List failed");
  });
});

describe("task/run IPC route", () => {
  test("method is task/run", () => {
    expect(taskRunRoute.method).toBe("task/run");
  });

  test("delegates with task_name and inputs", async () => {
    mockTaskRunResult = { content: "Task started", isError: false };

    const result = await taskRunRoute.handler({
      task_name: "deploy",
      inputs: { env: "prod" },
    });

    expect(result).toEqual({ ok: true, content: "Task started" });
    expect(mockTaskRunCalls).toHaveLength(1);
    expect(mockTaskRunCalls[0].input).toEqual({
      task_name: "deploy",
      inputs: { env: "prod" },
    });
  });

  test("delegates with task_id", async () => {
    await taskRunRoute.handler({ task_id: "tid-42" });

    expect(mockTaskRunCalls).toHaveLength(1);
    expect(mockTaskRunCalls[0].input).toEqual({ task_id: "tid-42" });
  });

  test("throws when executeTaskRun returns isError: true", async () => {
    mockTaskRunResult = { content: "Run failed", isError: true };

    await expect(taskRunRoute.handler({ task_name: "broken" })).rejects.toThrow(
      "Run failed",
    );
  });
});

describe("task/delete IPC route", () => {
  test("method is task/delete", () => {
    expect(taskDeleteRoute.method).toBe("task/delete");
  });

  test("delegates with task_ids array", async () => {
    mockTaskDeleteResult = { content: "Deleted 2 tasks", isError: false };

    const result = await taskDeleteRoute.handler({
      task_ids: ["id-1", "id-2"],
    });

    expect(result).toEqual({ ok: true, content: "Deleted 2 tasks" });
    expect(mockTaskDeleteCalls).toHaveLength(1);
    expect(mockTaskDeleteCalls[0].input).toEqual({
      task_ids: ["id-1", "id-2"],
    });
  });

  test("throws Zod validation error for empty task_ids array", async () => {
    await expect(taskDeleteRoute.handler({ task_ids: [] })).rejects.toThrow();

    expect(mockTaskDeleteCalls).toHaveLength(0);
  });

  test("throws Zod validation error for missing task_ids", async () => {
    await expect(taskDeleteRoute.handler({})).rejects.toThrow();

    expect(mockTaskDeleteCalls).toHaveLength(0);
  });

  test("throws when executeTaskDelete returns isError: true", async () => {
    mockTaskDeleteResult = { content: "Delete failed", isError: true };

    await expect(
      taskDeleteRoute.handler({ task_ids: ["id-1"] }),
    ).rejects.toThrow("Delete failed");
  });
});

// ===========================================================================
// Task queue routes
// ===========================================================================

describe("task/queue/show IPC route", () => {
  test("method is task/queue/show", () => {
    expect(taskQueueShowRoute.method).toBe("task/queue/show");
  });

  test("lists all when called with no params", async () => {
    mockWorkItemListResult = { content: "item1\nitem2", isError: false };

    const result = await taskQueueShowRoute.handler();

    expect(result).toEqual({ content: "item1\nitem2", isError: false });
    expect(mockWorkItemListCalls).toHaveLength(1);
  });

  test("passes status filter through", async () => {
    mockWorkItemListResult = { content: "queued items", isError: false };

    const result = await taskQueueShowRoute.handler({ status: "queued" });

    expect(result).toEqual({ content: "queued items", isError: false });
    expect(mockWorkItemListCalls).toHaveLength(1);
    expect(mockWorkItemListCalls[0].input).toEqual({ status: "queued" });
  });

  test("propagates isError from execute function", async () => {
    mockWorkItemListResult = { content: "Show failed", isError: true };

    const result = await taskQueueShowRoute.handler();

    expect(result).toEqual({ content: "Show failed", isError: true });
  });
});

describe("task/queue/add IPC route", () => {
  test("method is task/queue/add", () => {
    expect(taskQueueAddRoute.method).toBe("task/queue/add");
  });

  test("passes ad-hoc title through", async () => {
    mockWorkItemEnqueueResult = { content: "Item added", isError: false };

    const result = await taskQueueAddRoute.handler({
      title: "Fix homepage bug",
    });

    expect(result).toEqual({ content: "Item added", isError: false });
    expect(mockWorkItemEnqueueCalls).toHaveLength(1);
    expect(mockWorkItemEnqueueCalls[0].input).toEqual({
      title: "Fix homepage bug",
    });
  });

  test("passes task_id through", async () => {
    mockWorkItemEnqueueResult = {
      content: "Item added from template",
      isError: false,
    };

    const result = await taskQueueAddRoute.handler({ task_id: "tmpl-1" });

    expect(result).toEqual({
      content: "Item added from template",
      isError: false,
    });
    expect(mockWorkItemEnqueueCalls).toHaveLength(1);
    expect(mockWorkItemEnqueueCalls[0].input).toEqual({
      task_id: "tmpl-1",
    });
  });

  test("propagates isError from execute function", async () => {
    mockWorkItemEnqueueResult = { content: "Add failed", isError: true };

    const result = await taskQueueAddRoute.handler({
      title: "broken",
    });

    expect(result).toEqual({ content: "Add failed", isError: true });
  });
});

describe("task/queue/update IPC route", () => {
  test("method is task/queue/update", () => {
    expect(taskQueueUpdateRoute.method).toBe("task/queue/update");
  });

  test("delegates with work_item_id and status update", async () => {
    mockWorkItemUpdateResult = { content: "Updated", isError: false };

    const result = await taskQueueUpdateRoute.handler({
      work_item_id: "wi-1",
      status: "done",
    });

    expect(result).toEqual({ content: "Updated", isError: false });
    expect(mockWorkItemUpdateCalls).toHaveLength(1);
    expect(mockWorkItemUpdateCalls[0].input).toEqual({
      work_item_id: "wi-1",
      status: "done",
    });
  });

  test("propagates isError from execute function", async () => {
    mockWorkItemUpdateResult = { content: "Update failed", isError: true };

    const result = await taskQueueUpdateRoute.handler({
      work_item_id: "wi-1",
      status: "done",
    });

    expect(result).toEqual({ content: "Update failed", isError: true });
  });
});

describe("task/queue/remove IPC route", () => {
  test("method is task/queue/remove", () => {
    expect(taskQueueRemoveRoute.method).toBe("task/queue/remove");
  });

  test("delegates with work_item_id", async () => {
    mockWorkItemRemoveResult = { content: "Removed", isError: false };

    const result = await taskQueueRemoveRoute.handler({
      work_item_id: "wi-2",
    });

    expect(result).toEqual({ content: "Removed", isError: false });
    expect(mockWorkItemRemoveCalls).toHaveLength(1);
    expect(mockWorkItemRemoveCalls[0].input).toEqual({
      work_item_id: "wi-2",
    });
  });

  test("propagates isError from execute function", async () => {
    mockWorkItemRemoveResult = { content: "Remove failed", isError: true };

    const result = await taskQueueRemoveRoute.handler({
      work_item_id: "wi-2",
    });

    expect(result).toEqual({ content: "Remove failed", isError: true });
  });
});

describe("task/queue/run IPC route", () => {
  test("method is task/queue/run", () => {
    expect(taskQueueRunRoute.method).toBe("task/queue/run");
  });

  test("delegates with title", async () => {
    mockWorkItemRunResult = { content: "Running", isError: false };

    const result = await taskQueueRunRoute.handler({
      title: "Deploy staging",
    });

    expect(result).toEqual({ content: "Running", isError: false });
    expect(mockWorkItemRunCalls).toHaveLength(1);
    expect(mockWorkItemRunCalls[0].input).toEqual({
      title: "Deploy staging",
    });
  });

  test("delegates with work_item_id", async () => {
    mockWorkItemRunResult = { content: "Running by id", isError: false };

    const result = await taskQueueRunRoute.handler({
      work_item_id: "wi-5",
    });

    expect(result).toEqual({ content: "Running by id", isError: false });
    expect(mockWorkItemRunCalls).toHaveLength(1);
    expect(mockWorkItemRunCalls[0].input).toEqual({
      work_item_id: "wi-5",
    });
  });

  test("propagates isError from execute function", async () => {
    mockWorkItemRunResult = { content: "Run failed", isError: true };

    const result = await taskQueueRunRoute.handler({
      title: "broken",
    });

    expect(result).toEqual({ content: "Run failed", isError: true });
  });
});
