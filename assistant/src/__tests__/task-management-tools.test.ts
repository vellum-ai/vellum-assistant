import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "task-mgmt-test-"));

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    memory: {},
  }),
}));

mock.module("../tools/registry.js", () => ({
  registerTool: () => {},
  getTool: () => undefined,
  getAllTools: () => [],
}));

import type { Database } from "bun:sqlite";

import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { renderTemplate } from "../tasks/task-runner.js";
import {
  createTask,
  createTaskRun,
  deleteTask,
  deleteTasks,
  getTask,
  getTaskRun,
  listTasks,
  updateTaskRun,
} from "../tasks/task-store.js";
import { executeTaskDelete } from "../tools/tasks/task-delete.js";
import { executeTaskList } from "../tools/tasks/task-list.js";
import { executeTaskRun } from "../tools/tasks/task-run.js";
import { executeTaskSave } from "../tools/tasks/task-save.js";
import { executeTaskListAdd } from "../tools/tasks/work-item-enqueue.js";
import { executeTaskListShow } from "../tools/tasks/work-item-list.js";
import { executeTaskListRemove } from "../tools/tasks/work-item-remove.js";
import { executeTaskListUpdate } from "../tools/tasks/work-item-update.js";
import type { ToolContext } from "../tools/types.js";
import {
  createWorkItem,
  deleteWorkItem,
  findActiveWorkItemsByTaskId,
  findActiveWorkItemsByTitle,
  getWorkItem,
  identifyEntityById,
  listWorkItems,
  removeWorkItemFromQueue,
  resolveWorkItem,
  updateWorkItem,
} from "../work-items/work-item-store.js";

initializeDb();

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

const ctx: ToolContext = {
  workingDir: "/tmp",
  conversationId: "test-conversation",
  trustClass: "guardian",
};

function getRawDb(): Database {
  return (getDb() as unknown as { $client: Database }).$client;
}

function clearTables() {
  const db = getDb();
  db.run("DELETE FROM work_items");
  db.run("DELETE FROM task_runs");
  db.run("DELETE FROM tasks");
}

function clearTablesWithConversations() {
  const raw = getRawDb();
  raw.run("DELETE FROM work_items");
  raw.run("DELETE FROM task_runs");
  raw.run("DELETE FROM tasks");
  raw.run("DELETE FROM messages");
  raw.run("DELETE FROM conversations");
}

function createTestConversation(id: string): string {
  const raw = getRawDb();
  const now = Date.now();
  raw
    .query(
      `INSERT INTO conversations (id, title, created_at, updated_at, conversation_type, memory_scope_id) VALUES (?, 'Test', ?, ?, 'standard', 'default')`,
    )
    .run(id, now, now);
  return id;
}

function addTestMessage(
  conversationId: string,
  role: string,
  content: string,
): void {
  const raw = getRawDb();
  const id = crypto.randomUUID();
  const now = Date.now();
  raw
    .query(
      `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, conversationId, role, content, now);
}

// ═══════════════════════════════════════════════════════════════════
// Task Store — CRUD
// ═══════════════════════════════════════════════════════════════════

describe("task-store CRUD", () => {
  beforeEach(clearTables);

  test("createTask returns task with generated id and defaults", () => {
    const task = createTask({ title: "My Task", template: "do something" });
    expect(task.id).toBeTruthy();
    expect(task.title).toBe("My Task");
    expect(task.template).toBe("do something");
    expect(task.status).toBe("active");
    expect(task.inputSchema).toBeNull();
    expect(task.contextFlags).toBeNull();
    expect(task.requiredTools).toBeNull();
    expect(task.createdFromConversationId).toBeNull();
    expect(task.createdAt).toBeGreaterThan(0);
    expect(task.updatedAt).toBe(task.createdAt);
  });

  test("createTask with all optional fields", () => {
    const task = createTask({
      title: "Full Task",
      template: "run {{file_path}}",
      inputSchema: {
        type: "object",
        properties: { file_path: { type: "string" } },
      },
      contextFlags: ["needs_network"],
      requiredTools: ["bash", "file_read"],
      createdFromConversationId: "conv-123",
    });
    expect(task.inputSchema).toBe(
      JSON.stringify({
        type: "object",
        properties: { file_path: { type: "string" } },
      }),
    );
    expect(task.contextFlags).toBe(JSON.stringify(["needs_network"]));
    expect(task.requiredTools).toBe(JSON.stringify(["bash", "file_read"]));
    expect(task.createdFromConversationId).toBe("conv-123");
  });

  test("getTask retrieves existing task", () => {
    const created = createTask({ title: "Get Me", template: "hello" });
    const fetched = getTask(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.title).toBe("Get Me");
  });

  test("getTask returns undefined for non-existent id", () => {
    expect(getTask("nonexistent-id")).toBeUndefined();
  });

  test("listTasks returns all tasks", () => {
    createTask({ title: "First", template: "a" });
    createTask({ title: "Second", template: "b" });
    createTask({ title: "Third", template: "c" });
    const all = listTasks();
    expect(all).toHaveLength(3);
    const titles = all.map((t) => t.title).sort();
    expect(titles).toEqual(["First", "Second", "Third"]);
  });

  test("listTasks returns empty array when no tasks", () => {
    expect(listTasks()).toHaveLength(0);
  });

  test("deleteTask removes a task and returns true", () => {
    const task = createTask({ title: "Delete Me", template: "x" });
    expect(deleteTask(task.id)).toBe(true);
    expect(getTask(task.id)).toBeUndefined();
  });

  test("deleteTask returns false for non-existent id", () => {
    expect(deleteTask("nonexistent")).toBe(false);
  });

  test("deleteTask cascades to work items and task runs", () => {
    const task = createTask({ title: "Cascade", template: "y" });
    const workItem = createWorkItem({ taskId: task.id, title: "WI" });
    const run = createTaskRun(task.id);

    expect(getWorkItem(workItem.id)).toBeDefined();
    expect(getTaskRun(run.id)).toBeDefined();

    deleteTask(task.id);

    expect(getWorkItem(workItem.id)).toBeUndefined();
    expect(getTaskRun(run.id)).toBeUndefined();
  });

  test("deleteTasks removes multiple tasks", () => {
    const t1 = createTask({ title: "A", template: "a" });
    const t2 = createTask({ title: "B", template: "b" });
    const t3 = createTask({ title: "C", template: "c" });
    const count = deleteTasks([t1.id, t2.id]);
    expect(count).toBe(2);
    expect(getTask(t1.id)).toBeUndefined();
    expect(getTask(t2.id)).toBeUndefined();
    expect(getTask(t3.id)).toBeDefined();
  });

  test("deleteTasks with empty array returns 0", () => {
    expect(deleteTasks([])).toBe(0);
  });

  test("deleteTasks with non-existent ids returns 0", () => {
    expect(deleteTasks(["fake-1", "fake-2"])).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// TaskRun Store — CRUD
// ═══════════════════════════════════════════════════════════════════

describe("task-run store", () => {
  beforeEach(clearTables);

  test("createTaskRun creates a run with pending status", () => {
    const task = createTask({ title: "T", template: "t" });
    const run = createTaskRun(task.id);
    expect(run.id).toBeTruthy();
    expect(run.taskId).toBe(task.id);
    expect(run.status).toBe("pending");
    expect(run.startedAt).toBeNull();
    expect(run.finishedAt).toBeNull();
    expect(run.error).toBeNull();
  });

  test("updateTaskRun modifies fields", () => {
    const task = createTask({ title: "T", template: "t" });
    const run = createTaskRun(task.id);
    const now = Date.now();
    updateTaskRun(run.id, {
      status: "running",
      startedAt: now,
      conversationId: "conv-1",
    });
    const updated = getTaskRun(run.id);
    expect(updated!.status).toBe("running");
    expect(updated!.startedAt).toBe(now);
    expect(updated!.conversationId).toBe("conv-1");
  });

  test("getTaskRun returns undefined for non-existent id", () => {
    expect(getTaskRun("nonexistent")).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Work Item Store — CRUD
// ═══════════════════════════════════════════════════════════════════

describe("work-item store CRUD", () => {
  beforeEach(clearTables);

  test("createWorkItem with defaults", () => {
    const task = createTask({ title: "T", template: "t" });
    const item = createWorkItem({ taskId: task.id, title: "Work Item" });
    expect(item.id).toBeTruthy();
    expect(item.taskId).toBe(task.id);
    expect(item.title).toBe("Work Item");
    expect(item.status).toBe("queued");
    expect(item.priorityTier).toBe(1);
    expect(item.notes).toBeNull();
    expect(item.sortIndex).toBeNull();
  });

  test("createWorkItem with all options", () => {
    const task = createTask({ title: "T", template: "t" });
    const item = createWorkItem({
      taskId: task.id,
      title: "Full WI",
      notes: "Important",
      priorityTier: 0,
      sortIndex: 5,
      requiredTools: JSON.stringify(["bash"]),
    });
    expect(item.notes).toBe("Important");
    expect(item.priorityTier).toBe(0);
    expect(item.sortIndex).toBe(5);
    expect(item.requiredTools).toBe(JSON.stringify(["bash"]));
  });

  test("getWorkItem retrieves by id", () => {
    const task = createTask({ title: "T", template: "t" });
    const item = createWorkItem({ taskId: task.id, title: "WI" });
    const fetched = getWorkItem(item.id);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(item.id);
  });

  test("getWorkItem returns undefined for missing id", () => {
    expect(getWorkItem("missing")).toBeUndefined();
  });

  test("listWorkItems returns all items ordered by priority then sortIndex then updatedAt", () => {
    const task = createTask({ title: "T", template: "t" });
    createWorkItem({ taskId: task.id, title: "Low", priorityTier: 2 });
    createWorkItem({ taskId: task.id, title: "High", priorityTier: 0 });
    createWorkItem({ taskId: task.id, title: "Medium", priorityTier: 1 });
    const items = listWorkItems();
    expect(items).toHaveLength(3);
    expect(items[0].title).toBe("High");
    expect(items[1].title).toBe("Medium");
    expect(items[2].title).toBe("Low");
  });

  test("listWorkItems filters by status", () => {
    const task = createTask({ title: "T", template: "t" });
    createWorkItem({ taskId: task.id, title: "Queued" });
    const running = createWorkItem({ taskId: task.id, title: "Running" });
    updateWorkItem(running.id, { status: "running" });
    const queued = listWorkItems({ status: "queued" });
    expect(queued).toHaveLength(1);
    expect(queued[0].title).toBe("Queued");
  });

  test("updateWorkItem modifies fields and returns updated item", () => {
    const task = createTask({ title: "T", template: "t" });
    const item = createWorkItem({ taskId: task.id, title: "WI" });
    const updated = updateWorkItem(item.id, {
      notes: "Updated notes",
      priorityTier: 0,
    });
    expect(updated).toBeDefined();
    expect(updated!.notes).toBe("Updated notes");
    expect(updated!.priorityTier).toBe(0);
  });

  test("deleteWorkItem removes the item", () => {
    const task = createTask({ title: "T", template: "t" });
    const item = createWorkItem({ taskId: task.id, title: "WI" });
    deleteWorkItem(item.id);
    expect(getWorkItem(item.id)).toBeUndefined();
  });

  test("removeWorkItemFromQueue succeeds for existing item", () => {
    const task = createTask({ title: "T", template: "t" });
    const item = createWorkItem({ taskId: task.id, title: "Remove Me" });
    const result = removeWorkItemFromQueue(item.id);
    expect(result.success).toBe(true);
    expect(result.title).toBe("Remove Me");
    expect(getWorkItem(item.id)).toBeUndefined();
  });

  test("removeWorkItemFromQueue fails for non-existent item", () => {
    const result = removeWorkItemFromQueue("fake-id");
    expect(result.success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Work Item Selectors
// ═══════════════════════════════════════════════════════════════════

describe("work-item resolveWorkItem", () => {
  beforeEach(clearTables);

  test("resolves by workItemId", () => {
    const task = createTask({ title: "T", template: "t" });
    const item = createWorkItem({ taskId: task.id, title: "WI" });
    const result = resolveWorkItem({ workItemId: item.id });
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.workItem.id).toBe(item.id);
    }
  });

  test("resolves by taskId when single match", () => {
    const task = createTask({ title: "T", template: "t" });
    const item = createWorkItem({ taskId: task.id, title: "WI" });
    const result = resolveWorkItem({ taskId: task.id });
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.workItem.id).toBe(item.id);
    }
  });

  test("resolves by title (case-insensitive exact match)", () => {
    const task = createTask({ title: "T", template: "t" });
    createWorkItem({ taskId: task.id, title: "My Task" });
    const result = resolveWorkItem({ title: "my task" });
    expect(result.status).toBe("found");
  });

  test("returns not_found for non-existent workItemId", () => {
    const result = resolveWorkItem({ workItemId: "nonexistent" });
    expect(result.status).toBe("not_found");
  });

  test("returns not_found for done items looked up by workItemId", () => {
    const task = createTask({ title: "T", template: "t" });
    const item = createWorkItem({ taskId: task.id, title: "WI" });
    updateWorkItem(item.id, { status: "done" });
    const result = resolveWorkItem({ workItemId: item.id });
    expect(result.status).toBe("not_found");
  });

  test("returns not_found when no selector fields provided", () => {
    const result = resolveWorkItem({});
    expect(result.status).toBe("not_found");
  });

  test("returns ambiguous when multiple items match taskId", () => {
    const task = createTask({ title: "T", template: "t" });
    createWorkItem({ taskId: task.id, title: "WI 1" });
    createWorkItem({ taskId: task.id, title: "WI 2" });
    const result = resolveWorkItem({ taskId: task.id });
    expect(result.status).toBe("ambiguous");
  });

  test("disambiguates by priorityTier", () => {
    const task = createTask({ title: "T", template: "t" });
    createWorkItem({ taskId: task.id, title: "WI High", priorityTier: 0 });
    createWorkItem({ taskId: task.id, title: "WI Low", priorityTier: 2 });
    const result = resolveWorkItem({ taskId: task.id, priorityTier: 0 });
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.workItem.title).toBe("WI High");
    }
  });

  test("disambiguates by status", () => {
    const task = createTask({ title: "T", template: "t" });
    const _item1 = createWorkItem({ taskId: task.id, title: "Same" });
    const item2 = createWorkItem({ taskId: task.id, title: "Same" });
    updateWorkItem(item2.id, { status: "running" });
    const result = resolveWorkItem({ title: "Same", status: "running" });
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.workItem.id).toBe(item2.id);
    }
  });
});

describe("findActiveWorkItemsByTitle", () => {
  beforeEach(clearTables);

  test("finds items with matching title (case-insensitive)", () => {
    const task = createTask({ title: "T", template: "t" });
    createWorkItem({ taskId: task.id, title: "Build App" });
    const results = findActiveWorkItemsByTitle("build app");
    expect(results).toHaveLength(1);
  });

  test("excludes done and archived items", () => {
    const task = createTask({ title: "T", template: "t" });
    const item = createWorkItem({ taskId: task.id, title: "Build App" });
    updateWorkItem(item.id, { status: "done" });
    const results = findActiveWorkItemsByTitle("Build App");
    expect(results).toHaveLength(0);
  });
});

describe("findActiveWorkItemsByTaskId", () => {
  beforeEach(clearTables);

  test("finds active items for a task", () => {
    const task = createTask({ title: "T", template: "t" });
    createWorkItem({ taskId: task.id, title: "WI1" });
    createWorkItem({ taskId: task.id, title: "WI2" });
    const results = findActiveWorkItemsByTaskId(task.id);
    expect(results).toHaveLength(2);
  });

  test("excludes done items", () => {
    const task = createTask({ title: "T", template: "t" });
    const item = createWorkItem({ taskId: task.id, title: "WI1" });
    updateWorkItem(item.id, { status: "done" });
    const results = findActiveWorkItemsByTaskId(task.id);
    expect(results).toHaveLength(0);
  });
});

describe("identifyEntityById", () => {
  beforeEach(clearTables);

  test("identifies a task template", () => {
    const task = createTask({ title: "My Template", template: "t" });
    const entity = identifyEntityById(task.id);
    expect(entity.type).toBe("task_template");
    expect(entity.title).toBe("My Template");
  });

  test("identifies a work item", () => {
    const task = createTask({ title: "T", template: "t" });
    const item = createWorkItem({ taskId: task.id, title: "My Work Item" });
    const entity = identifyEntityById(item.id);
    expect(entity.type).toBe("work_item");
    expect(entity.title).toBe("My Work Item");
  });

  test("returns unknown for non-existent id", () => {
    const entity = identifyEntityById("nonexistent");
    expect(entity.type).toBe("unknown");
  });
});

// ═══════════════════════════════════════════════════════════════════
// renderTemplate
// ═══════════════════════════════════════════════════════════════════

describe("renderTemplate", () => {
  test("replaces known placeholders", () => {
    expect(renderTemplate("Hello {{name}}", { name: "World" })).toBe(
      "Hello World",
    );
  });

  test("replaces unknown placeholders with <MISSING: key>", () => {
    expect(renderTemplate("{{unknown}} text", {})).toBe(
      "<MISSING: unknown> text",
    );
  });

  test("handles multiple placeholders", () => {
    const result = renderTemplate("{{a}} and {{b}}", { a: "X", b: "Y" });
    expect(result).toBe("X and Y");
  });

  test("handles template with no placeholders", () => {
    expect(renderTemplate("plain text", {})).toBe("plain text");
  });

  test("handles empty template", () => {
    expect(renderTemplate("", {})).toBe("");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Tool: executeTaskList
// ═══════════════════════════════════════════════════════════════════

describe("executeTaskList tool", () => {
  beforeEach(clearTables);

  test("returns message when no tasks exist", async () => {
    const result = await executeTaskList({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("No task templates found");
  });

  test("lists existing tasks", async () => {
    createTask({ title: "Task Alpha", template: "alpha template" });
    createTask({
      title: "Task Beta",
      template: "beta template",
      requiredTools: ["bash"],
    });
    const result = await executeTaskList({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("2 task template(s)");
    expect(result.content).toContain("Task Alpha");
    expect(result.content).toContain("Task Beta");
    expect(result.content).toContain("bash");
  });

  test("shows input schema properties", async () => {
    createTask({
      title: "With Schema",
      template: "{{file_path}}",
      inputSchema: {
        type: "object",
        properties: { file_path: { type: "string" } },
      },
    });
    const result = await executeTaskList({}, ctx);
    expect(result.content).toContain("file_path");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Tool: executeTaskDelete
// ═══════════════════════════════════════════════════════════════════

describe("executeTaskDelete tool", () => {
  beforeEach(clearTables);

  test("rejects missing task_ids", async () => {
    const result = await executeTaskDelete({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("task_ids must be a non-empty array");
  });

  test("rejects empty array", async () => {
    const result = await executeTaskDelete({ task_ids: [] }, ctx);
    expect(result.isError).toBe(true);
  });

  test("rejects array of non-strings", async () => {
    const result = await executeTaskDelete({ task_ids: [123, null] }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("at least one non-empty string");
  });

  test("deletes a single task", async () => {
    const task = createTask({ title: "Delete Target", template: "x" });
    const result = await executeTaskDelete({ task_ids: [task.id] }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Deleted task");
    expect(result.content).toContain("Delete Target");
    expect(getTask(task.id)).toBeUndefined();
  });

  test("returns error for non-existent task id (single)", async () => {
    const result = await executeTaskDelete({ task_ids: ["nonexistent"] }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No task template or work item found");
  });

  test("falls back to work item removal for single id", async () => {
    const task = createTask({ title: "T", template: "t" });
    const item = createWorkItem({ taskId: task.id, title: "Fallback WI" });
    const result = await executeTaskDelete({ task_ids: [item.id] }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Removed");
    expect(getWorkItem(item.id)).toBeUndefined();
  });

  test("deletes multiple tasks in batch", async () => {
    const t1 = createTask({ title: "Batch A", template: "a" });
    const t2 = createTask({ title: "Batch B", template: "b" });
    const result = await executeTaskDelete({ task_ids: [t1.id, t2.id] }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Deleted 2 task(s)");
  });

  test("batch delete with no matches returns error", async () => {
    const result = await executeTaskDelete(
      { task_ids: ["fake1", "fake2"] },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No matching tasks found");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Tool: executeTaskRun
// ═══════════════════════════════════════════════════════════════════

describe("executeTaskRun tool", () => {
  beforeEach(clearTables);

  test("rejects when neither task_name nor task_id provided", async () => {
    const result = await executeTaskRun({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("At least one of task_name or task_id");
  });

  test("resolves by task_id and renders template", async () => {
    const task = createTask({ title: "Greet", template: "Hello {{name}}" });
    const result = await executeTaskRun(
      { task_id: task.id, inputs: { name: "World" } },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Hello World");
    expect(result.content).toContain("Greet");
  });

  test("resolves by task_name (case-insensitive substring)", async () => {
    createTask({ title: "Deploy Application", template: "deploying..." });
    const result = await executeTaskRun({ task_name: "deploy" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("deploying...");
  });

  test("returns error for non-existent task_id", async () => {
    const result = await executeTaskRun({ task_id: "nonexistent" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No task template found");
  });

  test("returns error for non-matching task_name", async () => {
    createTask({ title: "Alpha", template: "a" });
    const result = await executeTaskRun({ task_name: "zzz" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No task template matching");
  });

  test("returns error for missing required inputs", async () => {
    const task = createTask({
      title: "With Input",
      template: "{{url}}",
      inputSchema: { type: "object", properties: { url: { type: "string" } } },
    });
    const result = await executeTaskRun({ task_id: task.id }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Missing required inputs");
    expect(result.content).toContain("url");
  });

  test("includes required tools in output", async () => {
    const task = createTask({
      title: "T",
      template: "t",
      requiredTools: ["bash", "file_read"],
    });
    const result = await executeTaskRun({ task_id: task.id }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("bash");
    expect(result.content).toContain("file_read");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Tool: executeTaskListShow (work-item-list)
// ═══════════════════════════════════════════════════════════════════

describe("executeTaskListShow tool", () => {
  beforeEach(clearTables);

  test("shows empty message when no work items", async () => {
    const result = await executeTaskListShow({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("No tasks queued");
  });

  test("lists work items with priority labels", async () => {
    const task = createTask({ title: "T", template: "t" });
    createWorkItem({ taskId: task.id, title: "High Item", priorityTier: 0 });
    createWorkItem({ taskId: task.id, title: "Low Item", priorityTier: 2 });
    const result = await executeTaskListShow({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("2 items");
    expect(result.content).toContain("High Item");
    expect(result.content).toContain("Low Item");
  });

  test("filters by single status string", async () => {
    const task = createTask({ title: "T", template: "t" });
    createWorkItem({ taskId: task.id, title: "Queued" });
    const running = createWorkItem({ taskId: task.id, title: "Running" });
    updateWorkItem(running.id, { status: "running" });
    const result = await executeTaskListShow({ status: "running" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("1 running item");
    expect(result.content).toContain("Running");
  });

  test("filters by status array", async () => {
    const task = createTask({ title: "T", template: "t" });
    createWorkItem({ taskId: task.id, title: "Queued" });
    const running = createWorkItem({ taskId: task.id, title: "Running" });
    updateWorkItem(running.id, { status: "running" });
    const failed = createWorkItem({ taskId: task.id, title: "Failed" });
    updateWorkItem(failed.id, { status: "failed" });
    const result = await executeTaskListShow(
      { status: ["running", "failed"] },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("2 matching items");
  });

  test("shows no items matching filter", async () => {
    const task = createTask({ title: "T", template: "t" });
    createWorkItem({ taskId: task.id, title: "Queued" });
    const result = await executeTaskListShow({ status: "running" }, ctx);
    expect(result.content).toContain("No items matching that filter");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Tool: executeTaskListAdd (work-item-enqueue)
// ═══════════════════════════════════════════════════════════════════

describe("executeTaskListAdd tool", () => {
  beforeEach(clearTables);

  test("rejects when no identifiers provided", async () => {
    const result = await executeTaskListAdd({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "must provide either task_id, task_name, or title",
    );
  });

  test("creates ad-hoc work item from title alone", async () => {
    const result = await executeTaskListAdd({ title: "Ad-hoc Task" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Enqueued work item");
    expect(result.content).toContain("Ad-hoc Task");
    const items = listWorkItems();
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Ad-hoc Task");
  });

  test("ad-hoc task with notes and priority", async () => {
    const result = await executeTaskListAdd(
      {
        title: "Priority Task",
        notes: "Important task",
        priority_tier: 0,
      },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("high");
    const items = listWorkItems();
    expect(items[0].priorityTier).toBe(0);
    expect(items[0].notes).toBe("Important task");
  });

  test("enqueues from existing task by task_id", async () => {
    const task = createTask({ title: "Template Task", template: "do stuff" });
    const result = await executeTaskListAdd({ task_id: task.id }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Enqueued work item");
    expect(result.content).toContain("Template Task");
  });

  test("enqueues from existing task by task_name", async () => {
    createTask({ title: "Deploy App", template: "deploy" });
    const result = await executeTaskListAdd({ task_name: "deploy" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Enqueued work item");
    expect(result.content).toContain("Deploy App");
  });

  test("returns error for non-existent task_id", async () => {
    const result = await executeTaskListAdd({ task_id: "nonexistent" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No task definition found");
  });

  test("returns error for non-matching task_name", async () => {
    const result = await executeTaskListAdd({ task_name: "zzz" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No task definition found matching");
  });

  test("detects duplicates and reuses existing by default (reuse_existing)", async () => {
    const _task = createTask({ title: "T", template: "t" });
    await executeTaskListAdd({ title: "Dup Item" }, ctx);
    const result = await executeTaskListAdd({ title: "Dup Item" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("already exists");
    // Only one work item should exist
    const items = listWorkItems();
    expect(items).toHaveLength(1);
  });

  test("creates duplicate when if_exists=create_duplicate", async () => {
    await executeTaskListAdd({ title: "Dup Item" }, ctx);
    const result = await executeTaskListAdd(
      { title: "Dup Item", if_exists: "create_duplicate" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Enqueued work item");
    const items = listWorkItems();
    expect(items).toHaveLength(2);
  });

  test("update_existing modifies the existing item", async () => {
    await executeTaskListAdd({ title: "Update Target", priority_tier: 1 }, ctx);
    const result = await executeTaskListAdd(
      {
        title: "Update Target",
        priority_tier: 0,
        if_exists: "update_existing",
      },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Reused existing task");
    const items = listWorkItems();
    expect(items).toHaveLength(1);
    expect(items[0].priorityTier).toBe(0);
  });

  test("reports ambiguity when multiple tasks match task_name", async () => {
    createTask({ title: "Deploy Staging", template: "a" });
    createTask({ title: "Deploy Production", template: "b" });
    const result = await executeTaskListAdd({ task_name: "deploy" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Multiple task definitions match");
  });

  test("allows title override when using task_id", async () => {
    const task = createTask({ title: "Original", template: "do" });
    const result = await executeTaskListAdd(
      { task_id: task.id, title: "Custom Title" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Custom Title");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Tool: executeTaskListUpdate (work-item-update)
// ═══════════════════════════════════════════════════════════════════

describe("executeTaskListUpdate tool", () => {
  beforeEach(clearTables);

  test("updates status of a work item", async () => {
    const task = createTask({ title: "T", template: "t" });
    const item = createWorkItem({ taskId: task.id, title: "Update Me" });
    const result = await executeTaskListUpdate(
      { work_item_id: item.id, status: "running" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("status \u2192 running");
    const updated = getWorkItem(item.id);
    expect(updated!.status).toBe("running");
  });

  test("updates priority of a work item", async () => {
    const task = createTask({ title: "T", template: "t" });
    const item = createWorkItem({ taskId: task.id, title: "Update Me" });
    const result = await executeTaskListUpdate(
      { work_item_id: item.id, priority_tier: 0 },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("priority \u2192 high");
  });

  test("updates notes", async () => {
    const task = createTask({ title: "T", template: "t" });
    const item = createWorkItem({ taskId: task.id, title: "Update Me" });
    const result = await executeTaskListUpdate(
      { work_item_id: item.id, notes: "New notes" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("notes updated");
  });

  test("rejects direct transition to done status", async () => {
    const task = createTask({ title: "T", template: "t" });
    const item = createWorkItem({ taskId: task.id, title: "No Done" });
    const result = await executeTaskListUpdate(
      { work_item_id: item.id, status: "done" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Cannot mark as done from");
  });

  test("rejects update with no fields", async () => {
    const task = createTask({ title: "T", template: "t" });
    const item = createWorkItem({ taskId: task.id, title: "No Update" });
    const result = await executeTaskListUpdate({ work_item_id: item.id }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No updates specified");
  });

  test("returns error for non-existent work item", async () => {
    const result = await executeTaskListUpdate(
      { work_item_id: "nonexistent", status: "running" },
      ctx,
    );
    expect(result.isError).toBe(true);
  });

  test("resolves by title", async () => {
    const task = createTask({ title: "T", template: "t" });
    createWorkItem({ taskId: task.id, title: "Find Me By Title" });
    const result = await executeTaskListUpdate(
      { title: "Find Me By Title", status: "running" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("status \u2192 running");
  });

  test("reports entity mismatch when task template id used as work_item_id", async () => {
    const task = createTask({ title: "Template", template: "t" });
    const result = await executeTaskListUpdate(
      { work_item_id: task.id, status: "running" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Entity mismatch");
    expect(result.content).toContain("task template");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Tool: executeTaskListRemove (work-item-remove)
// ═══════════════════════════════════════════════════════════════════

describe("executeTaskListRemove tool", () => {
  beforeEach(clearTables);

  test("removes work item by work_item_id", async () => {
    const task = createTask({ title: "T", template: "t" });
    const item = createWorkItem({ taskId: task.id, title: "Remove This" });
    const result = await executeTaskListRemove({ work_item_id: item.id }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Removed");
    expect(result.content).toContain("Remove This");
    expect(getWorkItem(item.id)).toBeUndefined();
  });

  test("removes work item by title", async () => {
    const task = createTask({ title: "T", template: "t" });
    createWorkItem({ taskId: task.id, title: "Remove By Name" });
    const result = await executeTaskListRemove(
      { title: "Remove By Name" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Removed");
  });

  test("returns error for non-existent work item", async () => {
    const result = await executeTaskListRemove(
      { work_item_id: "nonexistent" },
      ctx,
    );
    expect(result.isError).toBe(true);
  });

  test("returns error when no selector provided", async () => {
    const result = await executeTaskListRemove({}, ctx);
    expect(result.isError).toBe(true);
  });

  test("reports entity mismatch when task template id used", async () => {
    const task = createTask({ title: "Template Not WI", template: "t" });
    const result = await executeTaskListRemove({ work_item_id: task.id }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Entity mismatch");
    expect(result.content).toContain("task template");
  });

  test("reports ambiguity when multiple items match", async () => {
    const task = createTask({ title: "T", template: "t" });
    createWorkItem({ taskId: task.id, title: "Ambiguous" });
    createWorkItem({ taskId: task.id, title: "Ambiguous" });
    const result = await executeTaskListRemove({ title: "Ambiguous" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Multiple items match");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Tool: executeTaskSave
// ═══════════════════════════════════════════════════════════════════

describe("executeTaskSave tool", () => {
  beforeEach(clearTablesWithConversations);

  test("creates a task from a conversation", async () => {
    const convId = createTestConversation("conv-save-1");
    addTestMessage(convId, "user", "Please summarize the document");
    addTestMessage(
      convId,
      "assistant",
      JSON.stringify([
        {
          type: "tool_use",
          id: "tu1",
          name: "file_read",
          input: { path: "/tmp/doc.txt" },
        },
      ]),
    );
    addTestMessage(convId, "assistant", "Here is the summary...");

    const result = await executeTaskSave({ conversation_id: convId }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Task saved successfully");
    expect(result.content).toContain("Please summarize the document");
    expect(result.content).toContain("file_read");
  });

  test("uses title override when provided", async () => {
    const convId = createTestConversation("conv-save-2");
    addTestMessage(convId, "user", "Read and analyze the logs");
    addTestMessage(convId, "assistant", "Done!");

    const result = await executeTaskSave(
      { conversation_id: convId, title: "My Custom Title" },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("My Custom Title");
  });

  test("uses context conversation_id when missing", async () => {
    const convId = createTestConversation(ctx.conversationId);
    addTestMessage(convId, "user", "Summarize the report");
    addTestMessage(convId, "assistant", "Done.");

    const result = await executeTaskSave({}, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Task saved successfully");
    expect(result.content).toContain("Summarize the report");
  });

  test("returns error for nonexistent conversation", async () => {
    const result = await executeTaskSave(
      { conversation_id: "nonexistent" },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("No messages found");
  });
});
