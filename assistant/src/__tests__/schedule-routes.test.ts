import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

const getOrCreateCalls: Array<{
  conversationId: string;
  options?: Record<string, unknown>;
}> = [];
const processCalls: Array<unknown[]> = [];
let fakeConversation: {
  taskRunId?: string;
  processMessage: (...args: unknown[]) => Promise<string>;
};

function resetConversationMock() {
  getOrCreateCalls.length = 0;
  processCalls.length = 0;
  fakeConversation = {
    taskRunId: "stale-task-run",
    async processMessage(...args: unknown[]) {
      processCalls.push(args);
      return "message-id";
    },
  };
}

mock.module("../daemon/conversation-store.js", () => ({
  getOrCreateConversation: async (
    conversationId: string,
    options?: Record<string, unknown>,
  ) => {
    getOrCreateCalls.push({ conversationId, options });
    return fakeConversation;
  },
}));

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { ROUTES } from "../runtime/routes/schedule-routes.js";
import type { RouteDefinition } from "../runtime/routes/types.js";
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

function findRoute(endpoint: string, method: string): RouteDefinition {
  const route = ROUTES.find(
    (r) => r.endpoint === endpoint && r.method === method,
  );
  if (!route) throw new Error(`Route ${method} ${endpoint} not found`);
  return route;
}

describe("schedule run-now trust propagation", () => {
  beforeEach(() => {
    clearTables();
    resetConversationMock();
  });

  test("manual run-now executes plain schedules with guardian trust", async () => {
    const schedule = createSchedule({
      name: "Direct schedule",
      cronExpression: "* * * * *",
      message: "scan my inbox",
      syntax: "cron",
    });

    const route = findRoute("schedules/:id/run", "POST");
    const result = (await route.handler({
      pathParams: { id: schedule.id },
    })) as { schedules: unknown[] };

    expect(result.schedules).toBeDefined();
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

    const observedTaskRunIds: Array<string | undefined> = [];
    fakeConversation = {
      taskRunId: undefined,
      async processMessage(...args: unknown[]) {
        observedTaskRunIds.push(fakeConversation.taskRunId);
        processCalls.push(args);
        return "message-id";
      },
    };

    const route = findRoute("schedules/:id/run", "POST");
    const result = (await route.handler({
      pathParams: { id: schedule.id },
    })) as { schedules: unknown[] };

    expect(result.schedules).toBeDefined();
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

describe("GET /schedules — default defer exclusion", () => {
  beforeEach(() => {
    clearTables();
  });

  test("excludes deferred wakes by default", () => {
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

    const route = findRoute("schedules", "GET");
    const result = route.handler({}) as {
      schedules: Array<{ id: string }>;
    };
    expect(result.schedules).toHaveLength(1);
    expect(result.schedules.every((s) => s.id !== deferred.id)).toBe(true);
  });

  test("returns all schedules when include_all=true", () => {
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

    const route = findRoute("schedules", "GET");
    const result = route.handler({
      queryParams: { include_all: "true" },
    }) as { schedules: Array<{ id: string }> };
    expect(result.schedules).toHaveLength(2);
  });

  test("mutation responses also exclude deferred wakes", () => {
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

    const route = findRoute("schedules/:id/toggle", "POST");
    const agent = listSchedules().find((j) => j.createdBy === "agent")!;
    const result = route.handler({
      pathParams: { id: agent.id },
      body: { enabled: false },
    }) as { schedules: Array<{ id: string }> };
    expect(result.schedules).toHaveLength(1);
    expect(result.schedules[0].id).toBe(agent.id);
  });
});

// ── schedules/:id/runs limit handling ─────────────────────────────────────

describe("schedule runs list — limit handling", () => {
  beforeEach(() => {
    clearTables();
  });

  test("returns with default limit when no param is provided", () => {
    const job = createSchedule({
      name: "runs default",
      cronExpression: "* * * * *",
      message: "hi",
      syntax: "cron",
    });
    for (let i = 0; i < 3; i += 1) {
      createScheduleRun(job.id, `conv-${i}`);
    }
    const route = findRoute("schedules/:id/runs", "GET");
    const result = route.handler({ pathParams: { id: job.id } }) as {
      runs: unknown[];
    };
    expect(Array.isArray(result.runs)).toBe(true);
    expect(result.runs).toHaveLength(3);
  });

  test("non-numeric limit falls back to default", () => {
    const job = createSchedule({
      name: "runs nan",
      cronExpression: "* * * * *",
      message: "hi",
      syntax: "cron",
    });
    createScheduleRun(job.id, "conv");
    const route = findRoute("schedules/:id/runs", "GET");
    const result = route.handler({
      pathParams: { id: job.id },
      queryParams: { limit: "abc" },
    }) as { runs: unknown[] };
    expect(Array.isArray(result.runs)).toBe(true);
  });

  test("negative limit is clamped to 1", () => {
    const job = createSchedule({
      name: "runs negative",
      cronExpression: "* * * * *",
      message: "hi",
      syntax: "cron",
    });
    for (let i = 0; i < 5; i += 1) {
      createScheduleRun(job.id, `conv-${i}`);
    }
    const route = findRoute("schedules/:id/runs", "GET");
    const result = route.handler({
      pathParams: { id: job.id },
      queryParams: { limit: "-5" },
    }) as { runs: unknown[] };
    expect(result.runs).toHaveLength(1);
  });

  test("zero limit is clamped to 1", () => {
    const job = createSchedule({
      name: "runs zero",
      cronExpression: "* * * * *",
      message: "hi",
      syntax: "cron",
    });
    for (let i = 0; i < 3; i += 1) {
      createScheduleRun(job.id, `conv-${i}`);
    }
    const route = findRoute("schedules/:id/runs", "GET");
    const result = route.handler({
      pathParams: { id: job.id },
      queryParams: { limit: "0" },
    }) as { runs: unknown[] };
    expect(result.runs).toHaveLength(1);
  });

  test("limit above 100 is capped at 100", () => {
    const job = createSchedule({
      name: "runs huge",
      cronExpression: "* * * * *",
      message: "hi",
      syntax: "cron",
    });
    for (let i = 0; i < 5; i += 1) {
      createScheduleRun(job.id, `conv-${i}`);
    }
    const route = findRoute("schedules/:id/runs", "GET");
    const result = route.handler({
      pathParams: { id: job.id },
      queryParams: { limit: "9999" },
    }) as { runs: unknown[] };
    expect(result.runs).toHaveLength(5);
  });

  test("fractional limit is floored", () => {
    const job = createSchedule({
      name: "runs frac",
      cronExpression: "* * * * *",
      message: "hi",
      syntax: "cron",
    });
    for (let i = 0; i < 5; i += 1) {
      createScheduleRun(job.id, `conv-${i}`);
    }
    const route = findRoute("schedules/:id/runs", "GET");
    const result = route.handler({
      pathParams: { id: job.id },
      queryParams: { limit: "2.7" },
    }) as { runs: unknown[] };
    expect(result.runs).toHaveLength(2);
  });
});

// ── Wake mode support ─────────────────────────────────────────────────────

describe("wake mode in schedule routes", () => {
  beforeEach(() => {
    clearTables();
  });

  test("PATCH accepts 'wake' as a valid mode", () => {
    const schedule = createSchedule({
      name: "Wake test",
      cronExpression: "* * * * *",
      message: "check deferred",
      syntax: "cron",
    });

    const route = findRoute("schedules/:id", "PATCH");
    const result = route.handler({
      pathParams: { id: schedule.id },
      body: { mode: "wake", wakeConversationId: "conv-xyz" },
    }) as {
      schedules: Array<{
        id: string;
        mode: string;
        wakeConversationId: string | null;
      }>;
    };
    const updated = result.schedules.find((s) => s.id === schedule.id);
    expect(updated).toBeDefined();
    expect(updated!.mode).toBe("wake");
    expect(updated!.wakeConversationId).toBe("conv-xyz");
  });

  test("list schedules includes wakeConversationId", () => {
    createSchedule({
      name: "Wake schedule",
      cronExpression: "0 9 * * *",
      message: "morning wake",
      syntax: "cron",
      mode: "wake",
      wakeConversationId: "conv-abc",
    });

    const route = findRoute("schedules", "GET");
    const result = route.handler({}) as {
      schedules: Array<{ name: string; wakeConversationId: string | null }>;
    };
    const wakeSchedule = result.schedules.find(
      (s) => s.name === "Wake schedule",
    );
    expect(wakeSchedule).toBeDefined();
    expect(wakeSchedule!.wakeConversationId).toBe("conv-abc");
  });
});
