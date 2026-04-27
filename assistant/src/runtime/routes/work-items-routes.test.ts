/**
 * Regression tests for empty required_tools snapshot bypass.
 *
 * Verifies that an explicitly empty `requiredTools: "[]"` snapshot on a work
 * item falls back to the task-level required tools instead of silently
 * skipping permission checks.
 */
import { describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../../permissions/checker.js", () => ({
  check: async () => ({ decision: "prompt" }),
  classifyRisk: async () => ({ level: "high" }),
}));

import { initializeDb } from "../../memory/db-init.js";
import { createTask } from "../../tasks/task-store.js";
import { createWorkItem } from "../../work-items/work-item-store.js";
import { ForbiddenError } from "./errors.js";
import { preflightWorkItem, ROUTES } from "./work-items-routes.js";

initializeDb();

describe("empty required_tools snapshot bypass", () => {
  test("falls back to task required tools when snapshot requiredTools is empty", async () => {
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

    const result = await preflightWorkItem(workItem.id);
    expect(result.success).toBe(true);
    expect(result.permissions).toHaveLength(1);
    expect(result.permissions![0].tool).toBe("host_bash");
  });

  test("rejects run when snapshot requiredTools is empty but task tools are unapproved", async () => {
    const task = createTask({
      title: "Test task for run",
      template: "Do something",
      requiredTools: ["host_bash"],
    });

    const workItem = createWorkItem({
      taskId: task.id,
      title: "Test work item for run",
      requiredTools: JSON.stringify([]),
    });

    const runRoute = ROUTES.find(
      (r) => r.endpoint === "work-items/:id/run" && r.method === "POST",
    )!;

    await expect(
      runRoute.handler({
        pathParams: { id: workItem.id },
        headers: {},
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
