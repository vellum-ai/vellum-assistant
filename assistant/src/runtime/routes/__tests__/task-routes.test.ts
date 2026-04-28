/**
 * Tests for the task template and task queue route definitions.
 *
 * Mocks the execute functions at the module boundary so route handlers
 * can be exercised without real task/queue state.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import type { ToolExecutionResult } from "../../../tools/types.js";

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

mock.module("../../../tools/tasks/task-save.js", () => ({
  executeTaskSave: async (
    input: Record<string, unknown>,
    context: { conversationId: string },
  ) => {
    mockTaskSaveCalls.push({ input, context });
    return mockTaskSaveResult;
  },
}));

mock.module("../../../tools/tasks/task-list.js", () => ({
  executeTaskList: async (
    input: Record<string, unknown>,
    context: { conversationId: string },
  ) => {
    mockTaskListCalls.push({ input, context });
    return mockTaskListResult;
  },
}));

mock.module("../../../tools/tasks/task-run.js", () => ({
  executeTaskRun: async (
    input: Record<string, unknown>,
    context: { conversationId: string },
  ) => {
    mockTaskRunCalls.push({ input, context });
    return mockTaskRunResult;
  },
}));

mock.module("../../../tools/tasks/task-delete.js", () => ({
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

mock.module("../../../tools/tasks/work-item-list.js", () => ({
  executeTaskListShow: async (
    input: Record<string, unknown>,
    context: { conversationId: string },
  ) => {
    mockWorkItemListCalls.push({ input, context });
    return mockWorkItemListResult;
  },
}));

mock.module("../../../tools/tasks/work-item-enqueue.js", () => ({
  executeTaskListAdd: async (
    input: Record<string, unknown>,
    context: { conversationId: string },
  ) => {
    mockWorkItemEnqueueCalls.push({ input, context });
    return mockWorkItemEnqueueResult;
  },
}));

mock.module("../../../tools/tasks/work-item-update.js", () => ({
  executeTaskListUpdate: async (
    input: Record<string, unknown>,
    context: { conversationId: string },
  ) => {
    mockWorkItemUpdateCalls.push({ input, context });
    return mockWorkItemUpdateResult;
  },
}));

mock.module("../../../tools/tasks/work-item-remove.js", () => ({
  executeTaskListRemove: async (
    input: Record<string, unknown>,
    context: { conversationId: string },
  ) => {
    mockWorkItemRemoveCalls.push({ input, context });
    return mockWorkItemRemoveResult;
  },
}));

mock.module("../../../tools/tasks/work-item-run.js", () => ({
  executeTaskQueueRun: async (
    input: Record<string, unknown>,
    context: { conversationId: string },
  ) => {
    mockWorkItemRunCalls.push({ input, context });
    return mockWorkItemRunResult;
  },
}));

// Also mock getWorkspaceDir so handlers don't hit the real filesystem
mock.module("../../../util/platform.js", () => ({
  getWorkspaceDir: () => "/mock/workspace",
}));

// ---------------------------------------------------------------------------
// Import route definitions after mocking
// ---------------------------------------------------------------------------

const { ROUTES } = await import("../task-routes.js");

function findRoute(opId: string) {
  const r = ROUTES.find((r) => r.operationId === opId);
  if (!r) throw new Error(`Route ${opId} not found`);
  return r;
}

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

describe("task_save route", () => {
  test("operationId is task_save", () => {
    expect(findRoute("task_save").operationId).toBe("task_save");
  });

  test("delegates to executeTaskSave with correct conversationId", async () => {
    mockTaskSaveResult = { content: "Task saved", isError: false };

    const route = findRoute("task_save");
    const result = await route.handler({
      body: { conversation_id: "conv-123", title: "My Task" },
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
    const route = findRoute("task_save");
    await route.handler({ body: {} });

    expect(mockTaskSaveCalls).toHaveLength(1);
    expect(mockTaskSaveCalls[0].context.conversationId).toBe("");
  });

  test("throws when executeTaskSave returns isError: true", async () => {
    mockTaskSaveResult = { content: "Save failed", isError: true };

    const route = findRoute("task_save");
    await expect(
      route.handler({ body: { conversation_id: "conv-1" } }),
    ).rejects.toThrow("Save failed");
  });
});

describe("task_list route", () => {
  test("operationId is task_list", () => {
    expect(findRoute("task_list").operationId).toBe("task_list");
  });

  test("delegates to executeTaskList with no params", async () => {
    mockTaskListResult = {
      content: "task1\ntask2",
      isError: false,
    };

    const route = findRoute("task_list");
    const result = await route.handler({ body: {} });

    expect(result).toEqual({ ok: true, content: "task1\ntask2" });
    expect(mockTaskListCalls).toHaveLength(1);
    expect(mockTaskListCalls[0].input).toEqual({});
  });

  test("throws when executeTaskList returns isError: true", async () => {
    mockTaskListResult = { content: "List failed", isError: true };

    const route = findRoute("task_list");
    await expect(route.handler({ body: {} })).rejects.toThrow("List failed");
  });
});

describe("task_run route", () => {
  test("operationId is task_run", () => {
    expect(findRoute("task_run").operationId).toBe("task_run");
  });

  test("delegates with task_name and inputs", async () => {
    mockTaskRunResult = { content: "Task started", isError: false };

    const route = findRoute("task_run");
    const result = await route.handler({
      body: { task_name: "deploy", inputs: { env: "prod" } },
    });

    expect(result).toEqual({ ok: true, content: "Task started" });
    expect(mockTaskRunCalls).toHaveLength(1);
    expect(mockTaskRunCalls[0].input).toEqual({
      task_name: "deploy",
      inputs: { env: "prod" },
    });
  });

  test("delegates with task_id", async () => {
    const route = findRoute("task_run");
    await route.handler({ body: { task_id: "tid-42" } });

    expect(mockTaskRunCalls).toHaveLength(1);
    expect(mockTaskRunCalls[0].input).toEqual({ task_id: "tid-42" });
  });

  test("throws when executeTaskRun returns isError: true", async () => {
    mockTaskRunResult = { content: "Run failed", isError: true };

    const route = findRoute("task_run");
    await expect(
      route.handler({ body: { task_name: "broken" } }),
    ).rejects.toThrow("Run failed");
  });
});

describe("task_delete route", () => {
  test("operationId is task_delete", () => {
    expect(findRoute("task_delete").operationId).toBe("task_delete");
  });

  test("delegates with task_ids array", async () => {
    mockTaskDeleteResult = { content: "Deleted 2 tasks", isError: false };

    const route = findRoute("task_delete");
    const result = await route.handler({
      body: { task_ids: ["id-1", "id-2"] },
    });

    expect(result).toEqual({ ok: true, content: "Deleted 2 tasks" });
    expect(mockTaskDeleteCalls).toHaveLength(1);
    expect(mockTaskDeleteCalls[0].input).toEqual({
      task_ids: ["id-1", "id-2"],
    });
  });

  test("throws Zod validation error for empty task_ids array", async () => {
    const route = findRoute("task_delete");
    await expect(
      route.handler({ body: { task_ids: [] } }),
    ).rejects.toThrow();

    expect(mockTaskDeleteCalls).toHaveLength(0);
  });

  test("throws Zod validation error for missing task_ids", async () => {
    const route = findRoute("task_delete");
    await expect(route.handler({ body: {} })).rejects.toThrow();

    expect(mockTaskDeleteCalls).toHaveLength(0);
  });

  test("throws when executeTaskDelete returns isError: true", async () => {
    mockTaskDeleteResult = { content: "Delete failed", isError: true };

    const route = findRoute("task_delete");
    await expect(
      route.handler({ body: { task_ids: ["id-1"] } }),
    ).rejects.toThrow("Delete failed");
  });
});

// ===========================================================================
// Task queue routes
// ===========================================================================

describe("task_queue_show route", () => {
  test("operationId is task_queue_show", () => {
    expect(findRoute("task_queue_show").operationId).toBe("task_queue_show");
  });

  test("lists all when called with empty body", async () => {
    mockWorkItemListResult = { content: "item1\nitem2", isError: false };

    const route = findRoute("task_queue_show");
    const result = await route.handler({ body: {} });

    expect(result).toEqual({ content: "item1\nitem2", isError: false });
    expect(mockWorkItemListCalls).toHaveLength(1);
  });

  test("passes status filter through", async () => {
    mockWorkItemListResult = { content: "queued items", isError: false };

    const route = findRoute("task_queue_show");
    const result = await route.handler({ body: { status: "queued" } });

    expect(result).toEqual({ content: "queued items", isError: false });
    expect(mockWorkItemListCalls).toHaveLength(1);
    expect(mockWorkItemListCalls[0].input).toEqual({ status: "queued" });
  });

  test("propagates isError from execute function", async () => {
    mockWorkItemListResult = { content: "Show failed", isError: true };

    const route = findRoute("task_queue_show");
    const result = await route.handler({ body: {} });

    expect(result).toEqual({ content: "Show failed", isError: true });
  });
});

describe("task_queue_add route", () => {
  test("operationId is task_queue_add", () => {
    expect(findRoute("task_queue_add").operationId).toBe("task_queue_add");
  });

  test("passes ad-hoc title through", async () => {
    mockWorkItemEnqueueResult = { content: "Item added", isError: false };

    const route = findRoute("task_queue_add");
    const result = await route.handler({
      body: { title: "Fix homepage bug" },
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

    const route = findRoute("task_queue_add");
    const result = await route.handler({ body: { task_id: "tmpl-1" } });

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

    const route = findRoute("task_queue_add");
    const result = await route.handler({ body: { title: "broken" } });

    expect(result).toEqual({ content: "Add failed", isError: true });
  });
});

describe("task_queue_update route", () => {
  test("operationId is task_queue_update", () => {
    expect(findRoute("task_queue_update").operationId).toBe(
      "task_queue_update",
    );
  });

  test("delegates with work_item_id and status update", async () => {
    mockWorkItemUpdateResult = { content: "Updated", isError: false };

    const route = findRoute("task_queue_update");
    const result = await route.handler({
      body: { work_item_id: "wi-1", status: "done" },
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

    const route = findRoute("task_queue_update");
    const result = await route.handler({
      body: { work_item_id: "wi-1", status: "done" },
    });

    expect(result).toEqual({ content: "Update failed", isError: true });
  });
});

describe("task_queue_remove route", () => {
  test("operationId is task_queue_remove", () => {
    expect(findRoute("task_queue_remove").operationId).toBe(
      "task_queue_remove",
    );
  });

  test("delegates with work_item_id", async () => {
    mockWorkItemRemoveResult = { content: "Removed", isError: false };

    const route = findRoute("task_queue_remove");
    const result = await route.handler({
      body: { work_item_id: "wi-2" },
    });

    expect(result).toEqual({ content: "Removed", isError: false });
    expect(mockWorkItemRemoveCalls).toHaveLength(1);
    expect(mockWorkItemRemoveCalls[0].input).toEqual({
      work_item_id: "wi-2",
    });
  });

  test("propagates isError from execute function", async () => {
    mockWorkItemRemoveResult = { content: "Remove failed", isError: true };

    const route = findRoute("task_queue_remove");
    const result = await route.handler({
      body: { work_item_id: "wi-2" },
    });

    expect(result).toEqual({ content: "Remove failed", isError: true });
  });
});

describe("task_queue_run route", () => {
  test("operationId is task_queue_run", () => {
    expect(findRoute("task_queue_run").operationId).toBe("task_queue_run");
  });

  test("delegates with title", async () => {
    mockWorkItemRunResult = { content: "Running", isError: false };

    const route = findRoute("task_queue_run");
    const result = await route.handler({
      body: { title: "Deploy staging" },
    });

    expect(result).toEqual({ content: "Running", isError: false });
    expect(mockWorkItemRunCalls).toHaveLength(1);
    expect(mockWorkItemRunCalls[0].input).toEqual({
      title: "Deploy staging",
    });
  });

  test("delegates with work_item_id", async () => {
    mockWorkItemRunResult = { content: "Running by id", isError: false };

    const route = findRoute("task_queue_run");
    const result = await route.handler({
      body: { work_item_id: "wi-5" },
    });

    expect(result).toEqual({ content: "Running by id", isError: false });
    expect(mockWorkItemRunCalls).toHaveLength(1);
    expect(mockWorkItemRunCalls[0].input).toEqual({
      work_item_id: "wi-5",
    });
  });

  test("propagates isError from execute function", async () => {
    mockWorkItemRunResult = { content: "Run failed", isError: true };

    const route = findRoute("task_queue_run");
    const result = await route.handler({ body: { title: "broken" } });

    expect(result).toEqual({ content: "Run failed", isError: true });
  });
});
