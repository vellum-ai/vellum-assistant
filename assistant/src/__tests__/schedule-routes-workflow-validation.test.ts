import { beforeEach, describe, expect, mock, test } from "bun:test";

// These tests exercise the PATCH-side `workflowName` validation, which only
// runs once the `workflows` feature flag is ON (the flag gate short-circuits
// first when it is off). Mock the flag resolver to ON so the validation path is
// reachable; the sibling schedule-routes.test.ts keeps the flag OFF and asserts
// the flag-gate behavior, so the two files do not conflict.
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: (key: string) => key === "workflows",
  getAssistantFeatureFlagValue: (key: string) => key === "workflows",
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({}),
  invalidateConfigCache: () => {},
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
}));

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { BadRequestError } from "../runtime/routes/errors.js";
import { ROUTES as SCHEDULE_ROUTES } from "../runtime/routes/schedule-routes.js";
import type { RouteDefinition } from "../runtime/routes/types.js";
import { createSchedule, listSchedules } from "../schedule/schedule-store.js";

initializeDb();

function clearTables(): void {
  const db = getDb();
  db.run("DELETE FROM cron_runs");
  db.run("DELETE FROM cron_jobs");
}

function patchRoute(): RouteDefinition {
  const route = SCHEDULE_ROUTES.find(
    (r) => r.endpoint === "schedules/:id" && r.method === "PATCH",
  );
  if (!route) throw new Error("PATCH schedules/:id route not found");
  return route;
}

function createRoute(): RouteDefinition {
  const route = SCHEDULE_ROUTES.find(
    (r) => r.endpoint === "schedules" && r.method === "POST",
  );
  if (!route) throw new Error("POST schedules route not found");
  return route;
}

describe("PATCH /schedules/:id — workflow-mode name validation", () => {
  beforeEach(clearTables);

  test("rejects switching mode to workflow without a workflowName (flag on)", () => {
    const schedule = createSchedule({
      name: "Plain execute",
      cronExpression: "0 9 * * *",
      message: "hi",
      syntax: "cron",
    });

    expect(() =>
      patchRoute().handler({
        pathParams: { id: schedule.id },
        body: { mode: "workflow" },
      }),
    ).toThrow("workflowName is required");

    // The schedule must stay in its prior mode — the wedge-prone nameless
    // workflow row was never persisted.
    expect(listSchedules()[0].mode).toBe("execute");
  });

  test("rejects switching to workflow with a blank/whitespace workflowName", () => {
    const schedule = createSchedule({
      name: "Plain execute",
      cronExpression: "0 9 * * *",
      message: "hi",
      syntax: "cron",
    });

    expect(() =>
      patchRoute().handler({
        pathParams: { id: schedule.id },
        body: { mode: "workflow", workflowName: "   " },
      }),
    ).toThrow("workflowName is required");
    expect(listSchedules()[0].mode).toBe("execute");
  });

  test("rejects clearing the workflowName on an already-workflow schedule", () => {
    // An existing workflow-mode schedule (created via the store, which is not
    // flag-gated). PATCH does not touch `mode`, so the resulting mode is still
    // `workflow` and a cleared name must be rejected.
    const schedule = createSchedule({
      name: "Workflow schedule",
      cronExpression: "0 9 * * *",
      message: "trigger",
      syntax: "cron",
      mode: "workflow",
      workflowName: "triage-inbox",
    });

    expect(() =>
      patchRoute().handler({
        pathParams: { id: schedule.id },
        body: { workflowName: "" },
      }),
    ).toThrow("workflowName is required");

    // Null clears the name too — same rejection.
    expect(() =>
      patchRoute().handler({
        pathParams: { id: schedule.id },
        body: { workflowName: null },
      }),
    ).toThrow("workflowName is required");

    // The original name is intact (neither PATCH was applied).
    expect(listSchedules()[0].workflowName).toBe("triage-inbox");
  });

  test("rejects with a BadRequestError instance (400 shape, matching create)", () => {
    const schedule = createSchedule({
      name: "Plain execute",
      cronExpression: "0 9 * * *",
      message: "hi",
      syntax: "cron",
    });

    expect(() =>
      patchRoute().handler({
        pathParams: { id: schedule.id },
        body: { mode: "workflow" },
      }),
    ).toThrow(BadRequestError);
  });

  test("allows switching to workflow mode WITH a valid workflowName", () => {
    const schedule = createSchedule({
      name: "Plain execute",
      cronExpression: "0 9 * * *",
      message: "hi",
      syntax: "cron",
    });

    const result = patchRoute().handler({
      pathParams: { id: schedule.id },
      body: { mode: "workflow", workflowName: "triage-inbox" },
    }) as { schedules: Array<{ id: string; mode: string }> };

    const updated = result.schedules.find((s) => s.id === schedule.id);
    expect(updated?.mode).toBe("workflow");
    expect(listSchedules()[0].workflowName).toBe("triage-inbox");
  });

  test("allows an unrelated PATCH on a workflow schedule (name untouched)", () => {
    const schedule = createSchedule({
      name: "Workflow schedule",
      cronExpression: "0 9 * * *",
      message: "trigger",
      syntax: "cron",
      mode: "workflow",
      workflowName: "triage-inbox",
    });

    // Patching only the message leaves mode=workflow and the name in place, so
    // the validation passes (it reads the persisted name).
    const result = patchRoute().handler({
      pathParams: { id: schedule.id },
      body: { message: "trigger now" },
    }) as { schedules: Array<{ id: string; workflowName: string | null }> };

    expect(result.schedules[0].workflowName).toBe("triage-inbox");
  });
});

describe("POST /schedules — workflow mode does not require a message", () => {
  beforeEach(clearTables);

  test("creates a workflow schedule with no message field", () => {
    // Workflow runs trigger workflowName/workflowArgs and ignore job.message,
    // so the endpoint must not force a dummy message for workflow mode.
    const result = createRoute().handler({
      body: {
        name: "Nightly triage",
        description: "Run the triage workflow",
        expression: "0 9 * * *",
        mode: "workflow",
        workflowName: "triage-inbox",
        // no `message`
      },
    }) as { schedules: Array<{ mode: string; workflowName: string | null }> };

    const created = result.schedules.find((s) => s.mode === "workflow");
    expect(created?.workflowName).toBe("triage-inbox");
  });

  test("still rejects a workflow schedule with no workflowName", () => {
    expect(() =>
      createRoute().handler({
        body: {
          name: "Nightly triage",
          description: "d",
          expression: "0 9 * * *",
          mode: "workflow",
        },
      }),
    ).toThrow("workflowName is required");
  });

  test("execute mode still requires a message", () => {
    expect(() =>
      createRoute().handler({
        body: {
          name: "Plain execute",
          description: "d",
          expression: "0 9 * * *",
          mode: "execute",
          // no `message`
        },
      }),
    ).toThrow("message is required");
  });
});
