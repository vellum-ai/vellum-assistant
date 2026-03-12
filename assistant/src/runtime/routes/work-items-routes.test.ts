/**
 * Tests for the work-item preflight and run permission bypass fix.
 *
 * Verifies that an empty requiredTools snapshot on a work item falls back
 * to the task template's tools instead of skipping the permission dialog.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "work-items-routes-test-"));

// ── Module mocks (must precede production imports) ───────────────────

mock.module("../../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getSocketPath: () => join(testDir, "test.sock"),
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../../permissions/checker.js", () => ({
  check: async () => ({ decision: "prompt" }),
  classifyRisk: async () => "high",
}));

// ── Production imports (after mocks) ─────────────────────────────────

import { getDb, initializeDb, resetDb } from "../../memory/db.js";
import { createTask } from "../../tasks/task-store.js";
import { createWorkItem } from "../../work-items/work-item-store.js";
import { preflightWorkItem } from "./work-items-routes.js";

// ── Lifecycle ────────────────────────────────────────────────────────

beforeAll(() => {
  initializeDb();
});

afterAll(() => {
  resetDb();
  rmSync(testDir, { recursive: true, force: true });
});

beforeEach(() => {
  const db = getDb();
  db.run("DELETE FROM work_items");
  db.run("DELETE FROM tasks");
});

// ── Tests ────────────────────────────────────────────────────────────

describe("preflightWorkItem", () => {
  test("falls back to task required tools when snapshot requiredTools is empty", async () => {
    const task = createTask({
      title: "Review",
      template: "Run review",
      requiredTools: ["host_bash"],
    });

    const workItem = createWorkItem({
      taskId: task.id,
      title: "Review item",
      requiredTools: JSON.stringify([]),
    });

    const result = await preflightWorkItem(workItem.id);

    expect(result.success).toBe(true);
    expect(result.permissions).toBeDefined();
    expect(result.permissions!.length).toBeGreaterThanOrEqual(1);
    expect(result.permissions!.some((p) => p.tool === "host_bash")).toBe(true);
  });

  test("uses snapshot tools when snapshot requiredTools is non-empty", async () => {
    const task = createTask({
      title: "Review",
      template: "Run review",
      requiredTools: ["host_bash", "file_write"],
    });

    const workItem = createWorkItem({
      taskId: task.id,
      title: "Review item",
      requiredTools: JSON.stringify(["file_write"]),
    });

    const result = await preflightWorkItem(workItem.id);

    expect(result.success).toBe(true);
    expect(result.permissions).toBeDefined();
    expect(result.permissions!.length).toBe(1);
    expect(result.permissions![0].tool).toBe("file_write");
  });

  test("falls back to task tools when snapshot requiredTools is null", async () => {
    const task = createTask({
      title: "Review",
      template: "Run review",
      requiredTools: ["host_bash"],
    });

    const workItem = createWorkItem({
      taskId: task.id,
      title: "Review item",
      // requiredTools omitted — stored as null
    });

    const result = await preflightWorkItem(workItem.id);

    expect(result.success).toBe(true);
    expect(result.permissions).toBeDefined();
    expect(result.permissions!.some((p) => p.tool === "host_bash")).toBe(true);
  });
});
