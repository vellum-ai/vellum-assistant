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

// Capture workflow-mode run-now dispatch. `handleRunScheduleNow`'s workflow
// branch calls `getWorkflowRunManager().start(...)`; stub the singleton so the
// trigger is observable without spinning up the real engine.
const workflowStartCalls: Array<Record<string, unknown>> = [];
mock.module("../workflows/run-manager.js", () => ({
  getWorkflowRunManager: () => ({
    start: (opts: Record<string, unknown>) => {
      workflowStartCalls.push(opts);
      return { runId: "wf-run-1" };
    },
  }),
}));

// Control the tool-registry readiness gate the run-now workflow branch checks
// before launching. Defaults to ready; the boot-race test flips it. Only the
// schedule route consumes registry in this test's graph, so a minimal mock
// suffices (mirrors task-scheduler.test.ts).
let coreToolsReady = true;
mock.module("../tools/registry.js", () => ({
  areCoreToolsInitialized: () => coreToolsReady,
}));

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import {
  BadRequestError,
  ServiceUnavailableError,
} from "../runtime/routes/errors.js";
import { ROUTES as SCHEDULE_ROUTES } from "../runtime/routes/schedule-routes.js";
import type { RouteDefinition } from "../runtime/routes/types.js";
import {
  createSchedule,
  getScheduleRuns,
  listSchedules,
} from "../schedule/schedule-store.js";

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

function runNowRoute(): RouteDefinition {
  const route = SCHEDULE_ROUTES.find(
    (r) => r.endpoint === "schedules/:id/run" && r.method === "POST",
  );
  if (!route) throw new Error("POST schedules/:id/run route not found");
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

describe("POST /schedules/:id/run — workflow mode triggers the workflow", () => {
  beforeEach(() => {
    clearTables();
    workflowStartCalls.length = 0;
    coreToolsReady = true;
  });

  test("starts the saved workflow instead of running a message turn", async () => {
    const schedule = createSchedule({
      name: "Nightly triage",
      cronExpression: "0 9 * * *",
      message: "", // workflow mode carries no message
      syntax: "cron",
      mode: "workflow",
      workflowName: "triage-inbox",
      workflowArgs: { scope: "unread" },
      // schedule_create stores the originating conversation here.
      createdFromConversationId: "conv-creator",
    });

    const result = (await runNowRoute().handler({
      pathParams: { id: schedule.id },
    })) as { schedules: Array<{ id: string }> };

    // The workflow was launched with the read-only baseline manifest and
    // guardian trust, forwarding name + args — not a message turn.
    expect(workflowStartCalls).toHaveLength(1);
    const call = workflowStartCalls[0]!;
    expect(call.name).toBe("triage-inbox");
    expect(call.args).toEqual({ scope: "unread" });
    expect(call.manifest).toEqual({
      tools: [],
      hostFunctions: [],
      persona: false,
    });
    expect((call.trustContext as { trustClass: string }).trustClass).toBe(
      "guardian",
    );
    // No wakeConversationId → completion summary targets the creating
    // conversation so the run's result is actually delivered.
    expect(call.conversationId).toBe("conv-creator");

    // A schedule run row was recorded as ok with the workflow run id.
    const runs = getScheduleRuns(schedule.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("ok");
    expect(runs[0].output).toContain("wf-run-1");
    // Response is the standard schedule list.
    expect(Array.isArray(result.schedules)).toBe(true);
  });

  test("rejects a workflow schedule with no workflowName", async () => {
    // Defensive guard mirroring the scheduler's automatic firing path; a
    // nameless workflow schedule cannot be created via the routes, but the store
    // does not enforce it, so run-now must fail fast rather than fall through.
    const schedule = createSchedule({
      name: "Nameless workflow",
      cronExpression: "0 9 * * *",
      message: "",
      syntax: "cron",
      mode: "workflow",
    });

    await expect(
      runNowRoute().handler({ pathParams: { id: schedule.id } }),
    ).rejects.toThrow("workflowName");
    expect(workflowStartCalls).toHaveLength(0);
  });

  test("defers (503) a manual run during the boot window before tools are ready", async () => {
    // Mirrors the scheduler's boot-race guard: launching before the read-only
    // baseline is registered would give the run an empty toolset. A manual run
    // can't defer to a later tick, so it fails fast with a retryable 503 and
    // never calls start().
    coreToolsReady = false;
    const schedule = createSchedule({
      name: "Nightly triage",
      cronExpression: "0 9 * * *",
      message: "",
      syntax: "cron",
      mode: "workflow",
      workflowName: "triage-inbox",
    });

    await expect(
      runNowRoute().handler({ pathParams: { id: schedule.id } }),
    ).rejects.toThrow(ServiceUnavailableError);
    expect(workflowStartCalls).toHaveLength(0);
    // No schedule run row was recorded — the guard trips before createScheduleRun.
    expect(getScheduleRuns(schedule.id)).toHaveLength(0);
  });
});
