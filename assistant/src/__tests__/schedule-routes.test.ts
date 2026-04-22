import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { getDb, initializeDb } from "../memory/db.js";
import { scheduleRouteDefinitions } from "../runtime/routes/schedule-routes.js";
import {
  createSchedule,
  createScheduleRun,
} from "../schedule/schedule-store.js";
import { scheduleTask } from "../tasks/task-scheduler.js";
import { createTask } from "../tasks/task-store.js";

initializeDb();

function clearTables(): void {
  const db = getDb();
  db.run("DELETE FROM cron_runs");
  db.run("DELETE FROM cron_jobs");
  db.run("DELETE FROM task_runs");
  db.run("DELETE FROM tasks");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

function getRunNowHandler(sendMessageDeps: {
  getOrCreateConversation: (
    conversationId: string,
    options?: Record<string, unknown>,
  ) => Promise<unknown>;
}) {
  const route = scheduleRouteDefinitions({
    sendMessageDeps: sendMessageDeps as never,
  }).find(
    (candidate) =>
      candidate.endpoint === "schedules/:id/run" && candidate.method === "POST",
  );
  if (!route) {
    throw new Error("Run-now schedule route not found");
  }
  return route.handler;
}

describe("schedule run-now trust propagation", () => {
  beforeEach(() => {
    clearTables();
  });

  test("manual run-now executes plain schedules with guardian trust", async () => {
    const schedule = createSchedule({
      name: "Direct schedule",
      cronExpression: "* * * * *",
      message: "scan my inbox",
      syntax: "cron",
    });

    const getOrCreateCalls: Array<{
      conversationId: string;
      options?: Record<string, unknown>;
    }> = [];
    const processCalls: Array<unknown[]> = [];
    const fakeConversation: {
      taskRunId?: string;
      processMessage: (...args: unknown[]) => Promise<string>;
    } = {
      taskRunId: "stale-task-run",
      async processMessage(...args: unknown[]) {
        processCalls.push(args);
        return "message-id";
      },
    };

    const handler = getRunNowHandler({
      getOrCreateConversation: async (conversationId, options) => {
        getOrCreateCalls.push({ conversationId, options });
        return fakeConversation;
      },
    });

    const response = await handler({
      req: new Request(`http://localhost/v1/schedules/${schedule.id}/run`, {
        method: "POST",
      }),
      url: new URL(`http://localhost/v1/schedules/${schedule.id}/run`),
      server: {} as never,
      authContext: {} as never,
      params: { id: schedule.id },
    });

    expect(response.status).toBe(200);
    expect(getOrCreateCalls).toHaveLength(1);
    expect(getOrCreateCalls[0].options?.trustContext).toEqual({
      sourceChannel: "vellum",
      trustClass: "guardian",
    });
    expect(processCalls).toHaveLength(1);
    expect(processCalls[0][0]).toBe("scan my inbox");
    expect(processCalls[0][6]).toEqual({ isInteractive: false });
    expect(fakeConversation.taskRunId).toBeUndefined();
  });

  test("manual run-now executes scheduled tasks with guardian trust and taskRunId", async () => {
    const task = createTask({
      title: "Email triage",
      template: "triage inbox in background",
    });
    const schedule = scheduleTask({
      taskId: task.id,
      name: "Scheduled task",
      cronExpression: "* * * * *",
    });

    const getOrCreateCalls: Array<{
      conversationId: string;
      options?: Record<string, unknown>;
    }> = [];
    const observedTaskRunIds: Array<string | undefined> = [];
    const processCalls: Array<unknown[]> = [];
    const fakeConversation: {
      taskRunId?: string;
      processMessage: (...args: unknown[]) => Promise<string>;
    } = {
      taskRunId: undefined,
      async processMessage(...args: unknown[]) {
        observedTaskRunIds.push(fakeConversation.taskRunId);
        processCalls.push(args);
        return "message-id";
      },
    };

    const handler = getRunNowHandler({
      getOrCreateConversation: async (conversationId, options) => {
        getOrCreateCalls.push({ conversationId, options });
        return fakeConversation;
      },
    });

    const response = await handler({
      req: new Request(`http://localhost/v1/schedules/${schedule.id}/run`, {
        method: "POST",
      }),
      url: new URL(`http://localhost/v1/schedules/${schedule.id}/run`),
      server: {} as never,
      authContext: {} as never,
      params: { id: schedule.id },
    });

    expect(response.status).toBe(200);
    expect(getOrCreateCalls).toHaveLength(1);
    expect(getOrCreateCalls[0].options?.trustContext).toEqual({
      sourceChannel: "vellum",
      trustClass: "guardian",
    });
    expect(processCalls).toHaveLength(1);
    expect(processCalls[0][0]).toBe("triage inbox in background");
    expect(processCalls[0][6]).toEqual({ isInteractive: false });
    expect(typeof observedTaskRunIds[0]).toBe("string");
    expect(fakeConversation.taskRunId).toBeUndefined();
  });
});

// ── schedules/:id/runs limit handling ─────────────────────────────────────

function getRunsHandler() {
  const route = scheduleRouteDefinitions({
    sendMessageDeps: {} as never,
  }).find(
    (candidate) =>
      candidate.endpoint === "schedules/:id/runs" &&
      candidate.method === "GET",
  );
  if (!route) throw new Error("Runs schedule route not found");
  return route.handler;
}

async function callRunsHandler(
  jobId: string,
  limitParam?: string,
): Promise<{ status: number; body: unknown }> {
  const handler = getRunsHandler();
  const suffix = limitParam !== undefined ? `?limit=${limitParam}` : "";
  const urlStr = `http://localhost/v1/schedules/${jobId}/runs${suffix}`;
  const response = await handler({
    req: new Request(urlStr),
    url: new URL(urlStr),
    server: {} as never,
    authContext: {} as never,
    params: { id: jobId },
  });
  return { status: response.status, body: await response.json() };
}

describe("schedule runs list — limit handling", () => {
  beforeEach(() => {
    clearTables();
  });

  test("returns 200 with default limit when no param is provided", async () => {
    const job = createSchedule({
      name: "runs default",
      cronExpression: "* * * * *",
      message: "hi",
      syntax: "cron",
    });
    for (let i = 0; i < 3; i += 1) {
      createScheduleRun(job.id, `conv-${i}`);
    }
    const { status, body } = await callRunsHandler(job.id);
    expect(status).toBe(200);
    expect(Array.isArray((body as { runs: unknown[] }).runs)).toBe(true);
    expect((body as { runs: unknown[] }).runs).toHaveLength(3);
  });

  test("non-numeric limit falls back to default (does not 500)", async () => {
    const job = createSchedule({
      name: "runs nan",
      cronExpression: "* * * * *",
      message: "hi",
      syntax: "cron",
    });
    createScheduleRun(job.id, "conv");
    const { status } = await callRunsHandler(job.id, "abc");
    expect(status).toBe(200);
  });

  test("negative limit is clamped to 1 (does not bypass cap)", async () => {
    const job = createSchedule({
      name: "runs negative",
      cronExpression: "* * * * *",
      message: "hi",
      syntax: "cron",
    });
    for (let i = 0; i < 5; i += 1) {
      createScheduleRun(job.id, `conv-${i}`);
    }
    const { status, body } = await callRunsHandler(job.id, "-5");
    expect(status).toBe(200);
    // clamped to 1, not interpreted as "no limit"
    expect((body as { runs: unknown[] }).runs).toHaveLength(1);
  });

  test("zero limit is clamped to 1", async () => {
    const job = createSchedule({
      name: "runs zero",
      cronExpression: "* * * * *",
      message: "hi",
      syntax: "cron",
    });
    for (let i = 0; i < 3; i += 1) {
      createScheduleRun(job.id, `conv-${i}`);
    }
    const { status, body } = await callRunsHandler(job.id, "0");
    expect(status).toBe(200);
    expect((body as { runs: unknown[] }).runs).toHaveLength(1);
  });

  test("limit above 100 is capped at 100", async () => {
    const job = createSchedule({
      name: "runs huge",
      cronExpression: "* * * * *",
      message: "hi",
      syntax: "cron",
    });
    // 5 runs, requesting 9999 → bounded at 100, actual returns = 5
    for (let i = 0; i < 5; i += 1) {
      createScheduleRun(job.id, `conv-${i}`);
    }
    const { status, body } = await callRunsHandler(job.id, "9999");
    expect(status).toBe(200);
    expect((body as { runs: unknown[] }).runs).toHaveLength(5);
  });

  test("fractional limit is floored", async () => {
    const job = createSchedule({
      name: "runs frac",
      cronExpression: "* * * * *",
      message: "hi",
      syntax: "cron",
    });
    for (let i = 0; i < 5; i += 1) {
      createScheduleRun(job.id, `conv-${i}`);
    }
    const { status, body } = await callRunsHandler(job.id, "2.7");
    expect(status).toBe(200);
    expect((body as { runs: unknown[] }).runs).toHaveLength(2);
  });
});
