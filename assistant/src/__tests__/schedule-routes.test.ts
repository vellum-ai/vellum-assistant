import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    heartbeat: {
      enabled: false,
      intervalMs: 60_000,
      activeHoursStart: null,
      activeHoursEnd: null,
      cronExpression: null,
      timezone: null,
    },
  }),
  invalidateConfigCache: () => {},
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
}));

mock.module("../heartbeat/heartbeat-service.js", () => ({
  HeartbeatService: {
    getInstance: () => null,
  },
}));

const getOrCreateCalls: Array<{
  conversationId: string;
  options?: Record<string, unknown>;
}> = [];
const processCalls: Array<Record<string, unknown>> = [];
let fakeConversation: {
  taskRunId?: string;
  processMessage: (options: Record<string, unknown>) => Promise<string>;
};

function resetConversationMock() {
  getOrCreateCalls.length = 0;
  processCalls.length = 0;
  fakeConversation = {
    taskRunId: "stale-task-run",
    async processMessage(options: Record<string, unknown>) {
      processCalls.push(options);
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

import { SYNC_TAGS } from "../daemon/message-types/sync.js";
import {
  insertPendingHeartbeatRun,
  startHeartbeatRun,
} from "../heartbeat/heartbeat-run-store.js";
import {
  archiveConversation,
  createConversation,
} from "../memory/conversation-crud.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { recordUsageEvent } from "../memory/llm-usage-store.js";
import { rawRun } from "../memory/raw-query.js";
import type { AssistantEvent } from "../runtime/assistant-event.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { BadRequestError } from "../runtime/routes/errors.js";
import { ROUTES as HEARTBEAT_ROUTES } from "../runtime/routes/heartbeat-routes.js";
import { ROUTES as SCHEDULE_ROUTES } from "../runtime/routes/schedule-routes.js";
import type { RouteDefinition } from "../runtime/routes/types.js";
import {
  completeScheduleRun,
  createSchedule,
  createScheduleRun,
  getScheduleRuns,
  listSchedules,
} from "../schedule/schedule-store.js";
import { scheduleTask } from "../tasks/task-scheduler.js";
import { createTask } from "../tasks/task-store.js";

initializeDb();

function clearTables(): void {
  const db = getDb();
  db.run("DELETE FROM llm_usage_events");
  db.run("DELETE FROM heartbeat_runs");
  db.run("DELETE FROM cron_runs");
  db.run("DELETE FROM cron_jobs");
  db.run("DELETE FROM task_runs");
  db.run("DELETE FROM tasks");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

function findRoute(endpoint: string, method: string): RouteDefinition {
  const route = SCHEDULE_ROUTES.find(
    (r) => r.endpoint === endpoint && r.method === method,
  );
  if (!route) throw new Error(`Route ${method} ${endpoint} not found`);
  return route;
}

function findHeartbeatRoute(endpoint: string, method: string): RouteDefinition {
  const route = HEARTBEAT_ROUTES.find(
    (r) => r.endpoint === endpoint && r.method === method,
  );
  if (!route) throw new Error(`Route ${method} ${endpoint} not found`);
  return route;
}

function recordUsageCostAt(
  conversationId: string,
  requestId: string,
  createdAt: number,
  estimatedCostUsd: number,
) {
  const event = recordUsageEvent(
    {
      conversationId,
      runId: null,
      requestId,
      actor: "main_agent",
      callSite: "mainAgent",
      inferenceProfile: "balanced",
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      rawUsage: null,
    },
    { estimatedCostUsd, pricingStatus: "priced" },
  );
  rawRun(
    "UPDATE llm_usage_events SET created_at = ? WHERE id = ?",
    createdAt,
    event.id,
  );
}

function setScheduleRunWindow({
  runId,
  startedAt,
  finishedAt,
  status = "ok",
}: {
  runId: string;
  startedAt: number;
  finishedAt: number | null;
  status?: "ok" | "error" | "running";
}) {
  rawRun(
    "UPDATE cron_runs SET status = ?, started_at = ?, finished_at = ?, duration_ms = ?, created_at = ? WHERE id = ?",
    status,
    startedAt,
    finishedAt,
    finishedAt == null ? null : finishedAt - startedAt,
    startedAt,
    runId,
  );
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for schedule route event");
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
    expect(processCalls[0].content).toBe("scan my inbox");
    expect(processCalls[0].isInteractive).toBe(false);
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
      async processMessage(options: Record<string, unknown>) {
        observedTaskRunIds.push(fakeConversation.taskRunId);
        processCalls.push(options);
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
    expect(processCalls[0].content).toBe("triage inbox in background");
    expect(processCalls[0].isInteractive).toBe(false);
    expect(typeof observedTaskRunIds[0]).toBe("string");
    expect(fakeConversation.taskRunId).toBeUndefined();
  });

  test("manual run-now opens task-backed schedule runs before task processing", async () => {
    const task = createTask({
      title: "Manual Usage Task",
      template: "spend tokens manually",
    });
    const schedule = scheduleTask({
      taskId: task.id,
      name: "Manual scheduled task",
      cronExpression: "* * * * *",
    });

    const from = Date.now() - 1000;
    let usageEventCreatedAt: number | null = null;
    let runsDuringProcessing: ReturnType<typeof getScheduleRuns> = [];
    fakeConversation = {
      taskRunId: undefined,
      async processMessage(options: Record<string, unknown>) {
        processCalls.push(options);
        const conversationId = getOrCreateCalls[0]?.conversationId;
        runsDuringProcessing = getScheduleRuns(schedule.id);
        usageEventCreatedAt = Date.now();
        recordUsageCostAt(
          conversationId ?? "missing-conversation",
          "manual-scheduled-task-usage",
          usageEventCreatedAt,
          0.25,
        );
        return "message-id";
      },
    };

    const route = findRoute("schedules/:id/run", "POST");
    await route.handler({ pathParams: { id: schedule.id } });
    const to = Date.now() + 1000;

    expect(usageEventCreatedAt).not.toBeNull();
    expect(runsDuringProcessing).toHaveLength(1);
    expect(runsDuringProcessing[0].status).toBe("running");
    expect(runsDuringProcessing[0].conversationId).toBeNull();
    expect(runsDuringProcessing[0].startedAt).toBeLessThanOrEqual(
      usageEventCreatedAt!,
    );

    const runs = getScheduleRuns(schedule.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe(runsDuringProcessing[0].id);
    expect(runs[0].status).toBe("ok");
    expect(runs[0].conversationId).toBe(getOrCreateCalls[0].conversationId);
    expect(runs[0].finishedAt).not.toBeNull();
    expect(runs[0].finishedAt!).toBeGreaterThanOrEqual(usageEventCreatedAt!);

    const summaryRoute = findRoute("schedules/usage-summary", "GET");
    const summaryResult = summaryRoute.handler({
      queryParams: { from: String(from), to: String(to) },
    }) as {
      summaries: Array<{
        scheduleId: string;
        runCount: number;
        totalEstimatedCostUsd: number;
        eventCount: number;
      }>;
    };
    expect(
      summaryResult.summaries.find((row) => row.scheduleId === schedule.id),
    ).toEqual({
      scheduleId: schedule.id,
      runCount: 1,
      totalEstimatedCostUsd: 0.25,
      eventCount: 1,
    });
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

  test("includes source conversation availability metadata", () => {
    const activeSource = createConversation("Active schedule source");
    const archivedSource = createConversation("Archived schedule source");
    expect(archiveConversation(archivedSource.id)).toBe(true);

    createSchedule({
      name: "Active source schedule",
      cronExpression: "* * * * *",
      message: "active source",
      syntax: "cron",
      createdFromConversationId: activeSource.id,
    });
    createSchedule({
      name: "Archived source schedule",
      cronExpression: "0 9 * * *",
      message: "archived source",
      syntax: "cron",
      createdFromConversationId: archivedSource.id,
    });
    createSchedule({
      name: "Missing source schedule",
      cronExpression: "0 10 * * *",
      message: "missing source",
      syntax: "cron",
      createdFromConversationId: "conv-missing",
    });
    createSchedule({
      name: "No source schedule",
      cronExpression: "0 11 * * *",
      message: "no source",
      syntax: "cron",
    });

    const route = findRoute("schedules", "GET");
    const result = route.handler({}) as {
      schedules: Array<{
        name: string;
        createdFromConversationId: string | null;
        createdFromConversationExists: boolean;
        createdFromConversationArchivedAt: number | null;
      }>;
    };

    const byName = new Map(result.schedules.map((s) => [s.name, s]));
    const active = byName.get("Active source schedule")!;
    expect(active.createdFromConversationId).toBe(activeSource.id);
    expect(active.createdFromConversationExists).toBe(true);
    expect(active.createdFromConversationArchivedAt).toBeNull();

    const archived = byName.get("Archived source schedule")!;
    expect(archived.createdFromConversationExists).toBe(true);
    expect(archived.createdFromConversationArchivedAt).toBeGreaterThan(0);

    const missing = byName.get("Missing source schedule")!;
    expect(missing.createdFromConversationId).toBe("conv-missing");
    expect(missing.createdFromConversationExists).toBe(false);
    expect(missing.createdFromConversationArchivedAt).toBeNull();

    const noSource = byName.get("No source schedule")!;
    expect(noSource.createdFromConversationId).toBeNull();
    expect(noSource.createdFromConversationExists).toBe(false);
    expect(noSource.createdFromConversationArchivedAt).toBeNull();
  });

  test("returns authored descriptions separately from cadence descriptions", () => {
    createSchedule({
      name: "Described schedule",
      description: "Review the morning queue",
      cronExpression: "0 9 * * *",
      message: "review queue",
      syntax: "cron",
    });

    const route = findRoute("schedules", "GET");
    const result = route.handler({}) as {
      schedules: Array<{
        name: string;
        description: string;
        cadenceDescription: string;
      }>;
    };

    expect(result.schedules).toHaveLength(1);
    expect(result.schedules[0]).toMatchObject({
      name: "Described schedule",
      description: "Review the morning queue",
      cadenceDescription: "Every day at 9:00 AM",
    });
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

  test("mutation routes emit schedule sync invalidation", async () => {
    const received: AssistantEvent[] = [];
    const subscription = assistantEventHub.subscribe({
      type: "process",
      callback: (event) => {
        received.push(event);
      },
    });

    try {
      const agent = createSchedule({
        name: "Agent schedule",
        cronExpression: "* * * * *",
        message: "hello",
        syntax: "cron",
      });
      await waitFor(() => received.length >= 1);
      received.length = 0;

      const route = findRoute("schedules/:id/toggle", "POST");
      route.handler({
        pathParams: { id: agent.id },
        body: { enabled: false },
      });

      await waitFor(() => received.length >= 1);
      expect(received[0].message).toEqual({
        type: "sync_changed",
        tags: [SYNC_TAGS.assistantSchedules],
      });
    } finally {
      subscription.dispose();
    }
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

// ── run metadata ──────────────────────────────────────────────────────────

describe("schedule and heartbeat run metadata", () => {
  beforeEach(() => {
    clearTables();
  });

  test("schedule runs expose conversation availability and cost by run window", () => {
    const job = createSchedule({
      name: "windowed run",
      cronExpression: "* * * * *",
      message: "hi",
      syntax: "cron",
      reuseConversation: true,
    });
    const conversation = createConversation({
      title: "Reused schedule conversation",
      source: "schedule",
      scheduleJobId: job.id,
    });
    const runId = createScheduleRun(job.id, conversation.id);
    completeScheduleRun(runId, { status: "ok" });
    rawRun(
      "UPDATE cron_runs SET started_at = ?, finished_at = ?, duration_ms = ?, created_at = ? WHERE id = ?",
      1000,
      2000,
      1000,
      1000,
      runId,
    );

    recordUsageCostAt(conversation.id, "req-before-run", 500, 0.5);
    recordUsageCostAt(conversation.id, "req-at-start", 1000, 0.01);
    recordUsageCostAt(conversation.id, "req-inside-run", 1500, 0.02);
    recordUsageCostAt(conversation.id, "req-at-finish", 2000, 0.03);
    recordUsageCostAt(conversation.id, "req-after-run", 2500, 0.75);

    const route = findRoute("schedules/:id/runs", "GET");
    const result = route.handler({ pathParams: { id: job.id } }) as {
      runs: Array<{
        conversationId: string | null;
        conversationExists: boolean;
        conversationArchivedAt: number | null;
        estimatedCostUsd: number;
      }>;
    };

    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].conversationId).toBe(conversation.id);
    expect(result.runs[0].conversationExists).toBe(true);
    expect(result.runs[0].conversationArchivedAt).toBeNull();
    expect(result.runs[0].estimatedCostUsd).toBeCloseTo(0.06);
  });

  test("schedule runs keep archived conversations distinguishable from missing ones", () => {
    const job = createSchedule({
      name: "archived conversation",
      cronExpression: "* * * * *",
      message: "hi",
      syntax: "cron",
    });
    const conversation = createConversation({
      title: "Archived schedule conversation",
      source: "schedule",
      scheduleJobId: job.id,
    });
    const archivedAt = 3000;
    rawRun(
      "UPDATE conversations SET archived_at = ? WHERE id = ?",
      archivedAt,
      conversation.id,
    );
    const runId = createScheduleRun(job.id, conversation.id);
    completeScheduleRun(runId, { status: "ok" });

    const route = findRoute("schedules/:id/runs", "GET");
    const result = route.handler({ pathParams: { id: job.id } }) as {
      runs: Array<{
        conversationExists: boolean;
        conversationArchivedAt: number | null;
      }>;
    };

    expect(result.runs[0].conversationExists).toBe(true);
    expect(result.runs[0].conversationArchivedAt).toBe(archivedAt);
  });

  test("schedule runs keep missing and synthetic conversation ids non-clickable", () => {
    const missingJob = createSchedule({
      name: "missing conversation",
      cronExpression: "* * * * *",
      message: "hi",
      syntax: "cron",
    });
    const missingRunId = createScheduleRun(missingJob.id, "conv-missing");
    completeScheduleRun(missingRunId, { status: "ok" });

    const scriptJob = createSchedule({
      name: "script schedule",
      cronExpression: "* * * * *",
      message: "",
      script: "echo hi",
      mode: "script",
      syntax: "cron",
    });
    const syntheticId = `script:${scriptJob.id}`;
    const scriptRunId = createScheduleRun(scriptJob.id, syntheticId);
    completeScheduleRun(scriptRunId, { status: "ok" });

    const route = findRoute("schedules/:id/runs", "GET");
    const missingResult = route.handler({
      pathParams: { id: missingJob.id },
    }) as {
      runs: Array<{
        conversationId: string | null;
        conversationExists: boolean;
        conversationArchivedAt: number | null;
      }>;
    };
    const scriptResult = route.handler({
      pathParams: { id: scriptJob.id },
    }) as {
      runs: Array<{
        conversationId: string | null;
        conversationExists: boolean;
        conversationArchivedAt: number | null;
      }>;
    };

    expect(missingResult.runs[0].conversationId).toBe("conv-missing");
    expect(missingResult.runs[0].conversationExists).toBe(false);
    expect(missingResult.runs[0].conversationArchivedAt).toBeNull();
    expect(scriptResult.runs[0].conversationId).toBe(syntheticId);
    expect(scriptResult.runs[0].conversationExists).toBe(false);
    expect(scriptResult.runs[0].conversationArchivedAt).toBeNull();
  });

  test("heartbeat runs expose conversation availability and cost from startedAt", () => {
    const conversation = createConversation({
      title: "Heartbeat conversation",
      source: "heartbeat",
    });
    const runId = insertPendingHeartbeatRun(900);
    startHeartbeatRun(runId);
    rawRun(
      "UPDATE heartbeat_runs SET status = 'ok', scheduled_for = ?, started_at = ?, finished_at = ?, duration_ms = ?, conversation_id = ?, created_at = ? WHERE id = ?",
      900,
      1000,
      2000,
      1000,
      conversation.id,
      900,
      runId,
    );

    recordUsageCostAt(conversation.id, "hb-before", 900, 0.4);
    recordUsageCostAt(conversation.id, "hb-at-start", 1000, 0.01);
    recordUsageCostAt(conversation.id, "hb-inside", 1500, 0.02);
    recordUsageCostAt(conversation.id, "hb-at-finish", 2000, 0.03);
    recordUsageCostAt(conversation.id, "hb-after", 2100, 0.5);

    const route = findHeartbeatRoute("heartbeat/runs", "GET");
    const result = route.handler({}) as {
      runs: Array<{
        conversationId: string | null;
        conversationExists: boolean;
        conversationArchivedAt: number | null;
        estimatedCostUsd: number;
      }>;
    };

    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].conversationId).toBe(conversation.id);
    expect(result.runs[0].conversationExists).toBe(true);
    expect(result.runs[0].conversationArchivedAt).toBeNull();
    expect(result.runs[0].estimatedCostUsd).toBeCloseTo(0.06);
  });

  test("heartbeat run cost falls back to scheduledFor when startedAt is missing", () => {
    const conversation = createConversation({
      title: "Heartbeat fallback conversation",
      source: "heartbeat",
    });
    const runId = insertPendingHeartbeatRun(1000);
    rawRun(
      "UPDATE heartbeat_runs SET status = 'running', finished_at = NULL, conversation_id = ?, created_at = ? WHERE id = ?",
      conversation.id,
      1000,
      runId,
    );

    recordUsageCostAt(conversation.id, "hb-fallback-before", 999, 0.4);
    recordUsageCostAt(conversation.id, "hb-fallback-inside", 1500, 0.02);

    const route = findHeartbeatRoute("heartbeat/runs", "GET");
    const result = route.handler({}) as {
      runs: Array<{ estimatedCostUsd: number }>;
    };

    expect(result.runs[0].estimatedCostUsd).toBeCloseTo(0.02);
  });
});

// ── schedules/usage-summary ───────────────────────────────────────────────

describe("GET /schedules/usage-summary", () => {
  beforeEach(() => {
    clearTables();
  });

  function getUsageSummary(queryParams: Record<string, string>) {
    const route = findRoute("schedules/usage-summary", "GET");
    return route.handler({ queryParams }) as {
      summaries: Array<{
        scheduleId: string;
        runCount: number;
        totalEstimatedCostUsd: number;
        eventCount: number;
      }>;
    };
  }

  test("returns zero rows when no schedules exist", () => {
    const result = getUsageSummary({ from: "0", to: "5000" });

    expect(result.summaries).toEqual([]);
  });

  test("includes active and inactive schedules with zero activity", () => {
    const active = createSchedule({
      name: "Active summary schedule",
      cronExpression: "* * * * *",
      message: "hi",
      syntax: "cron",
    });
    const inactive = createSchedule({
      name: "Inactive summary schedule",
      cronExpression: "0 9 * * *",
      message: "hi",
      syntax: "cron",
      enabled: false,
    });

    const result = getUsageSummary({ from: "0", to: "5000" });
    const byScheduleId = new Map(
      result.summaries.map((summary) => [summary.scheduleId, summary]),
    );

    expect(byScheduleId.get(active.id)).toEqual({
      scheduleId: active.id,
      runCount: 0,
      totalEstimatedCostUsd: 0,
      eventCount: 0,
    });
    expect(byScheduleId.get(inactive.id)).toEqual({
      scheduleId: inactive.id,
      runCount: 0,
      totalEstimatedCostUsd: 0,
      eventCount: 0,
    });
  });

  test("counts runs by started_at in the inclusive range regardless of status", () => {
    const schedule = createSchedule({
      name: "Run count schedule",
      cronExpression: "* * * * *",
      message: "hi",
      syntax: "cron",
    });
    const beforeRun = createScheduleRun(schedule.id, "conv-runs");
    const startRun = createScheduleRun(schedule.id, "conv-runs");
    const errorRun = createScheduleRun(schedule.id, "conv-runs");
    const runningRun = createScheduleRun(schedule.id, "conv-runs");
    const afterRun = createScheduleRun(schedule.id, "conv-runs");

    setScheduleRunWindow({
      runId: beforeRun,
      startedAt: 999,
      finishedAt: 1100,
    });
    setScheduleRunWindow({
      runId: startRun,
      startedAt: 1000,
      finishedAt: 1200,
    });
    setScheduleRunWindow({
      runId: errorRun,
      startedAt: 1500,
      finishedAt: 1700,
      status: "error",
    });
    setScheduleRunWindow({
      runId: runningRun,
      startedAt: 2000,
      finishedAt: null,
      status: "running",
    });
    setScheduleRunWindow({
      runId: afterRun,
      startedAt: 2001,
      finishedAt: 2100,
    });

    const result = getUsageSummary({ from: "1000", to: "2000" });

    expect(result.summaries).toHaveLength(1);
    expect(result.summaries[0].runCount).toBe(3);
  });

  test("sums usage by schedule run windows and excludes reused-conversation usage outside those windows", () => {
    const schedule = createSchedule({
      name: "Usage attribution schedule",
      cronExpression: "* * * * *",
      message: "hi",
      syntax: "cron",
      reuseConversation: true,
    });
    const conversation = createConversation({
      title: "Reused schedule conversation",
      source: "schedule",
      scheduleJobId: schedule.id,
    });
    const includedRun = createScheduleRun(schedule.id, conversation.id);
    const outsideRangeRun = createScheduleRun(schedule.id, conversation.id);

    setScheduleRunWindow({
      runId: includedRun,
      startedAt: 1000,
      finishedAt: 2000,
    });
    setScheduleRunWindow({
      runId: outsideRangeRun,
      startedAt: 3000,
      finishedAt: 3500,
    });

    recordUsageCostAt(conversation.id, "summary-before-run", 900, 0.4);
    recordUsageCostAt(conversation.id, "summary-at-start", 1000, 0.01);
    recordUsageCostAt(conversation.id, "summary-inside-run", 1500, 0.02);
    recordUsageCostAt(conversation.id, "summary-at-finish", 2000, 0.03);
    recordUsageCostAt(conversation.id, "summary-between-runs", 2500, 0.5);
    recordUsageCostAt(conversation.id, "summary-outside-range-run", 3200, 0.8);

    const result = getUsageSummary({ from: "1000", to: "2000" });

    expect(result.summaries).toHaveLength(1);
    expect(result.summaries[0]).toMatchObject({
      scheduleId: schedule.id,
      runCount: 1,
      eventCount: 3,
    });
    expect(result.summaries[0].totalEstimatedCostUsd).toBeCloseTo(0.06);
  });

  test("validates required numeric range parameters", () => {
    expect(() => getUsageSummary({ to: "2000" })).toThrow(BadRequestError);
    expect(() => getUsageSummary({ from: "1000" })).toThrow(BadRequestError);
    expect(() => getUsageSummary({ from: "abc", to: "2000" })).toThrow(
      BadRequestError,
    );
    expect(() => getUsageSummary({ from: "3000", to: "2000" })).toThrow(
      BadRequestError,
    );
  });
});

// ── POST /schedules — create ─────────────────────────────────────────────

describe("POST /schedules — create", () => {
  beforeEach(() => {
    clearTables();
  });

  function postCreate(body: Record<string, unknown>) {
    const route = findRoute("schedules", "POST");
    return route.handler({ body }) as { schedules: Array<{ id: string }> };
  }

  test("creates a recurring execute schedule with defaults", () => {
    const result = postCreate({
      name: "Morning ping",
      description: "Start the morning workflow",
      expression: "0 9 * * *",
      message: "good morning",
    });
    expect(result.schedules).toHaveLength(1);
    const job = listSchedules()[0];
    expect(job.name).toBe("Morning ping");
    expect(job.mode).toBe("execute");
    expect(job.expression).toBe("0 9 * * *");
    expect(job.syntax).toBe("cron");
    expect(job.description).toBe("Start the morning workflow");
    expect(job.enabled).toBe(true);
    expect(job.timezone).toBeNull();
  });

  test("trims whitespace and accepts an explicit timezone", () => {
    postCreate({
      name: "  Trimmed  ",
      description: "  Trimmed description  ",
      expression: "  0 9 * * *  ",
      message: "hi",
      timezone: " America/New_York ",
    });
    const job = listSchedules()[0];
    expect(job.name).toBe("Trimmed");
    expect(job.description).toBe("Trimmed description");
    expect(job.expression).toBe("0 9 * * *");
    expect(job.timezone).toBe("America/New_York");
  });

  test("accepts an rrule expression and detects syntax", () => {
    const expression = "DTSTART:20260101T000000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO";
    postCreate({
      name: "Weekly",
      description: "Weekly wake",
      expression,
      message: "monday wake",
    });
    const job = listSchedules()[0];
    expect(job.syntax).toBe("rrule");
    expect(job.expression).toBe(expression);
  });

  test("rejects missing required fields", () => {
    expect(() =>
      postCreate({ expression: "* * * * *", message: "hi" }),
    ).toThrow("name is required");
    expect(() => postCreate({ name: "x", message: "hi" })).toThrow(
      "expression is required",
    );
    expect(() => postCreate({ name: "x", expression: "* * * * *" })).toThrow(
      "message is required",
    );
    expect(() =>
      postCreate({ name: "x", expression: "* * * * *", message: "hi" }),
    ).toThrow("description is required");
    expect(() =>
      postCreate({
        name: "x",
        description: "   ",
        expression: "* * * * *",
        message: "hi",
      }),
    ).toThrow("description is required");
  });

  test("rejects non-execute modes", () => {
    expect(() =>
      postCreate({
        name: "x",
        description: "Run the thing",
        expression: "* * * * *",
        message: "hi",
        mode: "notify",
      }),
    ).toThrow("Only 'execute' mode is supported");
  });

  test("rejects an unparseable expression", () => {
    expect(() =>
      postCreate({
        name: "x",
        description: "Run the thing",
        expression: "not-a-cron",
        message: "hi",
      }),
    ).toThrow("could not be parsed");
  });

  test("surfaces invalid-cron errors from the store as 400s", () => {
    expect(() =>
      postCreate({
        name: "x",
        description: "Run the thing",
        expression: "99 99 99 99 99",
        message: "hi",
      }),
    ).toThrow();
  });

  test("respects enabled=false", () => {
    postCreate({
      name: "Off",
      description: "Disabled schedule",
      expression: "0 9 * * *",
      message: "hi",
      enabled: false,
    });
    const job = listSchedules()[0];
    expect(job.enabled).toBe(false);
  });
});

// ── PATCH /schedules/:id — description ───────────────────────────────────

describe("PATCH /schedules/:id — description", () => {
  beforeEach(() => {
    clearTables();
  });

  test("updates authored descriptions", () => {
    const schedule = createSchedule({
      name: "Description update",
      description: "Original description",
      cronExpression: "0 9 * * *",
      message: "hi",
      syntax: "cron",
    });

    const route = findRoute("schedules/:id", "PATCH");
    const result = route.handler({
      pathParams: { id: schedule.id },
      body: { description: "Updated description" },
    }) as {
      schedules: Array<{ id: string; description: string }>;
    };

    expect(result.schedules[0]).toMatchObject({
      id: schedule.id,
      description: "Updated description",
    });
    expect(listSchedules()[0].description).toBe("Updated description");
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

describe("PATCH /schedules/:id — timeout override", () => {
  beforeEach(() => {
    clearTables();
  });

  function listOne(): { id: string; timeoutMs: number | null } {
    const route = findRoute("schedules", "GET");
    const result = route.handler({}) as {
      schedules: Array<{ id: string; timeoutMs: number | null }>;
    };
    return result.schedules[0];
  }

  test("sets and clears the script timeout, exposing it in the list", () => {
    // GIVEN a script schedule with no timeout override
    const schedule = createSchedule({
      name: "Script job",
      cronExpression: "0 9 * * *",
      message: "",
      script: "echo hi",
      mode: "script",
      syntax: "cron",
    });
    expect(listOne().timeoutMs).toBeNull();

    const patch = findRoute("schedules/:id", "PATCH");

    // WHEN the guardian sets a custom timeout
    patch.handler({
      pathParams: { id: schedule.id },
      body: { timeoutMs: 5000 },
    });

    // THEN the list reflects the override
    expect(listOne().timeoutMs).toBe(5000);

    // AND WHEN the guardian clears it
    patch.handler({
      pathParams: { id: schedule.id },
      body: { timeoutMs: null },
    });

    // THEN it reverts to null
    expect(listOne().timeoutMs).toBeNull();
  });

  test("rejects an out-of-range timeout", () => {
    // GIVEN a script schedule
    const schedule = createSchedule({
      name: "Guarded job",
      cronExpression: "0 9 * * *",
      message: "",
      script: "echo hi",
      mode: "script",
      syntax: "cron",
    });

    const patch = findRoute("schedules/:id", "PATCH");

    // WHEN/THEN patching with a below-minimum timeout throws a RouteError
    expect(() =>
      patch.handler({
        pathParams: { id: schedule.id },
        body: { timeoutMs: 10 },
      }),
    ).toThrow("timeout_ms must be between");
    expect(listOne().timeoutMs).toBeNull();
  });
});
