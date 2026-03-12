/**
 * Tests for work-items-routes security fix:
 * empty `required_tools` snapshot must fall back to task template tools,
 * not bypass the preflight approval dialog.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "work-items-routes-test-"));

mock.module("../../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
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
  classifyRisk: async () => "medium",
}));

import { getDb, initializeDb, resetDb } from "../../memory/db.js";
import { createTask } from "../../tasks/task-store.js";
import { createWorkItem } from "../../work-items/work-item-store.js";
import type { RouteContext } from "../http-router.js";
import {
  preflightWorkItem,
  workItemRouteDefinitions,
} from "./work-items-routes.js";

initializeDb();

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

beforeEach(() => {
  const db = (getDb() as unknown as { $client: { run: (sql: string) => void } })
    .$client;
  db.run("DELETE FROM work_items");
  db.run("DELETE FROM tasks");
});

// ── resolveRequiredTools via preflightWorkItem ───────────────────────────────

describe("preflight: empty snapshot falls back to task required tools", () => {
  test("returns the task's required tools when work-item snapshot is empty []", async () => {
    const task = createTask({
      title: "Test task",
      template: "Do something",
      requiredTools: ["host_bash"],
    });

    const workItem = createWorkItem({
      taskId: task.id,
      title: "Test work item",
      // Empty array snapshot — the bug: this used to short-circuit to []
      requiredTools: JSON.stringify([]),
    });

    const result = await preflightWorkItem(workItem.id);

    expect(result.success).toBe(true);
    expect(result.permissions).toBeDefined();
    expect(result.permissions!.length).toBe(1);
    expect(result.permissions![0].tool).toBe("host_bash");
  });
});

// ── run handler: 403 when snapshot is empty and task tools unapproved ────────

describe("run handler: 403 when empty snapshot and task tools unapproved", () => {
  test("returns 403 FORBIDDEN when work-item has empty required_tools and no approvals", async () => {
    const task = createTask({
      title: "Test task",
      template: "Do something",
      requiredTools: ["host_bash"],
    });

    const workItem = createWorkItem({
      taskId: task.id,
      title: "Test work item",
      requiredTools: JSON.stringify([]),
    });

    const routes = workItemRouteDefinitions();
    const runRoute = routes.find(
      (r) => r.endpoint === "work-items/:id/run" && r.method === "POST",
    );

    expect(runRoute).toBeDefined();

    const mockReq = new Request(
      "http://localhost/v1/work-items/" + workItem.id + "/run",
      {
        method: "POST",
      },
    );

    const response = await runRoute!.handler({
      req: mockReq,
      params: { id: workItem.id },
      url: new URL(mockReq.url),
    } as unknown as RouteContext);

    expect(response.status).toBe(403);
  });
});
