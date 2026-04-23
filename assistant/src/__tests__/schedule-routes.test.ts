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
  listSchedules,
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

// ── GET /schedules — default defer exclusion ──────────────────────────────

function getListHandler() {
  const route = scheduleRouteDefinitions({
    sendMessageDeps: {} as never,
  }).find(
    (candidate) =>
      candidate.endpoint === "schedules" && candidate.method === "GET",
  );
  if (!route) throw new Error("List schedules route not found");
  return route.handler;
}

async function callListHandler(
  includeAll?: boolean,
): Promise<{ status: number; body: { schedules: Array<{ id: string }> } }> {
  const handler = getListHandler();
  const suffix = includeAll ? "?include_all=true" : "";
  const urlStr = `http://localhost/v1/schedules${suffix}`;
  const response = await handler({
    req: new Request(urlStr),
    url: new URL(urlStr),
    server: {} as never,
    authContext: {} as never,
    params: {},
  });
  return {
    status: response.status,
    body: (await response.json()) as { schedules: Array<{ id: string }> },
  };
}

describe("GET /schedules — default defer exclusion", () => {
  beforeEach(() => {
    clearTables();
  });

  test("excludes deferred wakes by default", async () => {
    createSchedule({
      name: "Agent schedule",
      cronExpression: "* * * * *",
      message: "hello",
      syntax: "cron",
    });
    const deferred = createSchedule({
      name: "Deferred wake",
      cronExpression: "0 9 * * *",
      message: "wake up",
      syntax: "cron",
      createdBy: "defer",
    });

    const { status, body } = await callListHandler();
    expect(status).toBe(200);
    expect(body.schedules).toHaveLength(1);
    expect(body.schedules.every((s) => s.id !== deferred.id)).toBe(true);
  });

  test("returns all schedules when include_all=true", async () => {
    createSchedule({
      name: "Agent schedule",
      cronExpression: "* * * * *",
      message: "hello",
      syntax: "cron",
    });
    createSchedule({
      name: "Deferred wake",
      cronExpression: "0 9 * * *",
      message: "wake up",
      syntax: "cron",
      createdBy: "defer",
    });

    const { status, body } = await callListHandler(true);
    expect(status).toBe(200);
    expect(body.schedules).toHaveLength(2);
  });

  test("mutation responses also exclude deferred wakes", async () => {
    createSchedule({
      name: "Agent schedule",
      cronExpression: "* * * * *",
      message: "hello",
      syntax: "cron",
    });
    createSchedule({
      name: "Deferred wake",
      cronExpression: "0 9 * * *",
      message: "wake up",
      syntax: "cron",
      createdBy: "defer",
    });

    const toggleHandler = scheduleRouteDefinitions({
      sendMessageDeps: {} as never,
    }).find(
      (r) => r.endpoint === "schedules/:id/toggle" && r.method === "POST",
    )!.handler;

    const agent = listSchedules().find((j) => j.createdBy === "agent")!;
    const urlStr = `http://localhost/v1/schedules/${agent.id}/toggle`;
    const response = await toggleHandler({
      req: new Request(urlStr, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      }),
      url: new URL(urlStr),
      server: {} as never,
      authContext: {} as never,
      params: { id: agent.id },
    });
    const body = (await response.json()) as {
      schedules: Array<{ id: string }>;
    };
    expect(body.schedules).toHaveLength(1);
    expect(body.schedules[0].id).toBe(agent.id);
  });
});

// ── schedules/:id/runs limit handling ─────────────────────────────────────

function getRunsHandler() {
  const route = scheduleRouteDefinitions({
    sendMessageDeps: {} as never,
  }).find(
    (candidate) =>
      candidate.endpoint === "schedules/:id/runs" && candidate.method === "GET",
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

// ── Wake mode support ─────────────────────────────────────────────────────

function getPatchHandler() {
  const route = scheduleRouteDefinitions({
    sendMessageDeps: {} as never,
  }).find(
    (candidate) =>
      candidate.endpoint === "schedules/:id" && candidate.method === "PATCH",
  );
  if (!route) throw new Error("PATCH schedule route not found");
  return route.handler;
}

describe("wake mode in schedule routes", () => {
  beforeEach(() => {
    clearTables();
  });

  test("PATCH accepts 'wake' as a valid mode", async () => {
    const schedule = createSchedule({
      name: "Wake test",
      cronExpression: "* * * * *",
      message: "check deferred",
      syntax: "cron",
    });

    const handler = getPatchHandler();
    const urlStr = `http://localhost/v1/schedules/${schedule.id}`;
    const response = await handler({
      req: new Request(urlStr, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "wake", wakeConversationId: "conv-xyz" }),
      }),
      url: new URL(urlStr),
      server: {} as never,
      authContext: {} as never,
      params: { id: schedule.id },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      schedules: Array<{
        id: string;
        mode: string;
        wakeConversationId: string | null;
      }>;
    };
    const updated = body.schedules.find((s) => s.id === schedule.id);
    expect(updated).toBeDefined();
    expect(updated!.mode).toBe("wake");
    expect(updated!.wakeConversationId).toBe("conv-xyz");
  });

  test("list schedules includes wakeConversationId", async () => {
    createSchedule({
      name: "Wake schedule",
      cronExpression: "0 9 * * *",
      message: "morning wake",
      syntax: "cron",
      mode: "wake",
      wakeConversationId: "conv-abc",
    });

    const handler = getListHandler();
    const response = await handler({
      req: new Request("http://localhost/v1/schedules"),
      url: new URL("http://localhost/v1/schedules"),
      server: {} as never,
      authContext: {} as never,
      params: {},
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      schedules: Array<{ name: string; wakeConversationId: string | null }>;
    };
    const wakeSchedule = body.schedules.find((s) => s.name === "Wake schedule");
    expect(wakeSchedule).toBeDefined();
    expect(wakeSchedule!.wakeConversationId).toBe("conv-abc");
  });
});
