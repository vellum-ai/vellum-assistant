import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { SchedulerDueWorkResult } from "../schedule/scheduler.js";
import type { BackgroundWakeIntent } from "./next-wake.js";
import {
  clearBackgroundWakeRuntime,
  registerBackgroundWakeRuntime,
} from "./runtime-registry.js";

type MockIntent = BackgroundWakeIntent;

let computedIntent: MockIntent | null;
let computeCalls: number;

const { ROUTES, setBackgroundWakeIntentComputerForTest } =
  await import("../runtime/routes/background-wake-routes.js");

function findHandler(operationId: string) {
  const route = ROUTES.find(
    (candidate) => candidate.operationId === operationId,
  );
  if (!route) throw new Error(`Route ${operationId} not found`);
  return route.handler;
}

const NOW = 1_800_000_000_000;

function schedulerResultFixture(
  overrides: Partial<SchedulerDueWorkResult> = {},
): SchedulerDueWorkResult {
  return {
    claimed: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    stillPending: 0,
    ...overrides,
  };
}

function firstCallArg(fn: {
  mock: { calls: unknown[] };
}): Record<string, unknown> {
  const call = fn.mock.calls[0] as unknown[] | undefined;
  return (call?.[0] ?? {}) as Record<string, unknown>;
}

describe("background wake runtime routes", () => {
  beforeEach(() => {
    clearBackgroundWakeRuntime();
    computeCalls = 0;
    computedIntent = intentFixture({ nextWakeAt: Date.now() + 10 * 60_000 });
    setBackgroundWakeIntentComputerForTest(() => {
      computeCalls += 1;
      return computedIntent;
    });
  });

  afterEach(() => {
    setBackgroundWakeIntentComputerForTest(null);
  });

  test("intent route returns the current computed wake intent", async () => {
    const handler = findHandler("getBackgroundWakeIntent");

    expect(await handler({})).toEqual({ intent: computedIntent });
    expect(computeCalls).toBe(1);
  });

  test("intent route returns null when no wake intent exists", async () => {
    computedIntent = null;
    const handler = findHandler("getBackgroundWakeIntent");

    expect(await handler({})).toEqual({ intent: null });
  });

  test("prepare-sleep defers when the next wake is inside the local window", async () => {
    computedIntent = intentFixture({ nextWakeAt: Date.now() + 30_000 });
    const handler = findHandler("prepareBackgroundWakeSleep");

    expect(await handler({})).toEqual({
      intent: computedIntent,
      deferSleep: true,
    });
  });

  test("prepare-sleep allows sleep when the next wake is outside the local window", async () => {
    computedIntent = intentFixture({ nextWakeAt: Date.now() + 5 * 60_000 });
    const handler = findHandler("prepareBackgroundWakeSleep");

    expect(await handler({})).toEqual({
      intent: computedIntent,
      deferSleep: false,
    });
  });

  test("drain-due fails when the runtime registry is missing", async () => {
    const handler = findHandler("drainDueBackgroundWake");

    await expect(handler({ body: drainBodyFixture() })).rejects.toThrow(
      "Background wake runtime is not registered",
    );
  });

  test("drain-due invokes due heartbeat and scheduler work", async () => {
    const dueAt = Date.now() - 1;
    const recomputedIntent = intentFixture({
      nextWakeAt: Date.now() + 60_000,
      sourceGeneration: "next-generation",
    });
    computedIntent = intentFixture({
      nextWakeAt: dueAt,
      actualNextDueAt: dueAt,
      reason: "mixed",
    });
    const heartbeatRunManaged = mock(async () => ({
      due: true,
      completed: 1,
      skipped: 0,
    }));
    const schedulerRunDue = mock(async () => {
      computedIntent = recomputedIntent;
      return schedulerResultFixture({ claimed: 2, completed: 2 });
    });
    registerBackgroundWakeRuntime({
      heartbeat: {
        nextRunAt: dueAt,
        runManagedWakeIfDue: heartbeatRunManaged,
      },
      scheduler: {
        runOnce: mock(async () => 2),
        runDueWorkOnce: schedulerRunDue,
      },
    });
    const handler = findHandler("drainDueBackgroundWake");

    const response = await handler({
      body: drainBodyFixture({ reason: "mixed" }),
    });

    expect(heartbeatRunManaged).toHaveBeenCalledTimes(1);
    expect(heartbeatRunManaged).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledFor: NOW }),
    );
    expect(firstCallArg(heartbeatRunManaged)).not.toHaveProperty("assumeDue");
    expect(schedulerRunDue).toHaveBeenCalledTimes(1);
    expect(response).toEqual({
      leaseId: "lease-123",
      reason: "mixed",
      sourceGeneration: "source-generation",
      startedAt: NOW,
      deadlineAt: NOW + 30_000,
      counts: {
        heartbeat: 1,
        scheduler: 2,
        total: 3,
        completed: 3,
        failed: 0,
        skipped: 0,
        claimed: 2,
        stillPending: 0,
      },
      completed: 3,
      failed: 0,
      skipped: 0,
      nextIntent: recomputedIntent,
      dueWorkRemaining: false,
    });
  });

  test("drain-due skips heartbeat when it is not due and reports no scheduler work", async () => {
    const heartbeatRunManaged = mock(async () => ({
      due: true,
      completed: 1,
      skipped: 0,
    }));
    const schedulerRunDue = mock(async () => schedulerResultFixture());
    registerBackgroundWakeRuntime({
      heartbeat: {
        nextRunAt: Date.now() + 5 * 60_000,
        runManagedWakeIfDue: heartbeatRunManaged,
      },
      scheduler: {
        runOnce: mock(async () => 0),
        runDueWorkOnce: schedulerRunDue,
      },
    });
    const handler = findHandler("drainDueBackgroundWake");

    const response = (await handler({ body: drainBodyFixture() })) as {
      counts: {
        heartbeat: number;
        scheduler: number;
        total: number;
        completed: number;
        failed: number;
        skipped: number;
        claimed: number;
        stillPending: number;
      };
    };

    expect(heartbeatRunManaged).not.toHaveBeenCalled();
    expect(schedulerRunDue).toHaveBeenCalledTimes(1);
    expect(response.counts).toEqual({
      heartbeat: 0,
      scheduler: 0,
      total: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      claimed: 0,
      stillPending: 0,
    });
  });

  test("drain-due recomputes the next intent after due work drains", async () => {
    const recomputedIntent = intentFixture({
      nextWakeAt: NOW + 2 * 60_000,
      sourceGeneration: "after-drain",
    });
    const schedulerRunOnce = mock(async () => {
      computedIntent = recomputedIntent;
      return schedulerResultFixture({ claimed: 1, completed: 1 });
    });
    registerBackgroundWakeRuntime({
      heartbeat: {
        nextRunAt: null,
        runManagedWakeIfDue: mock(async () => ({
          due: false,
          completed: 0,
          skipped: 0,
        })),
      },
      scheduler: {
        runOnce: mock(async () => 1),
        runDueWorkOnce: schedulerRunOnce,
      },
    });
    const handler = findHandler("drainDueBackgroundWake");

    const response = (await handler({ body: drainBodyFixture() })) as {
      nextIntent: MockIntent | null;
    };

    expect(response.nextIntent).toEqual(recomputedIntent);
  });

  test("drain-due runs scheduler backlog on heartbeat-only drains", async () => {
    const dueAt = Date.now() - 1;
    const recomputedIntent = intentFixture({
      nextWakeAt: Date.now() + 60_000,
      sourceGeneration: "after-heartbeat-drain",
    });
    computedIntent = intentFixture({
      nextWakeAt: dueAt,
      actualNextDueAt: dueAt,
      reason: "heartbeat",
    });
    const heartbeatRunManaged = mock(async () => ({
      due: true,
      completed: 1,
      skipped: 0,
    }));
    const schedulerRunDue = mock(async () => {
      computedIntent = recomputedIntent;
      return schedulerResultFixture({ claimed: 1, completed: 1 });
    });
    registerBackgroundWakeRuntime({
      heartbeat: {
        nextRunAt: dueAt,
        runManagedWakeIfDue: heartbeatRunManaged,
      },
      scheduler: {
        runOnce: mock(async () => 1),
        runDueWorkOnce: schedulerRunDue,
      },
    });
    const handler = findHandler("drainDueBackgroundWake");

    const response = await handler({
      body: drainBodyFixture({ reason: "heartbeat" }),
    });

    expect(heartbeatRunManaged).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduledFor: NOW,
      }),
    );
    expect(firstCallArg(heartbeatRunManaged)).not.toHaveProperty("assumeDue");
    expect(schedulerRunDue).toHaveBeenCalledTimes(1);
    expect(response).toMatchObject({
      completed: 2,
      failed: 0,
      skipped: 0,
      dueWorkRemaining: false,
    });
  });

  test("drain-due does not rerun heartbeat for stale heartbeat drain requests", async () => {
    const heartbeatRunManaged = mock(async () => ({
      due: true,
      completed: 1,
      skipped: 0,
    }));
    const schedulerRunDue = mock(async () => schedulerResultFixture());
    registerBackgroundWakeRuntime({
      heartbeat: {
        nextRunAt: Date.now() + 30 * 60_000,
        runManagedWakeIfDue: heartbeatRunManaged,
      },
      scheduler: {
        runOnce: mock(async () => 0),
        runDueWorkOnce: schedulerRunDue,
      },
    });
    const handler = findHandler("drainDueBackgroundWake");

    const response = await handler({
      body: drainBodyFixture({ reason: "heartbeat" }),
    });

    expect(heartbeatRunManaged).not.toHaveBeenCalled();
    expect(schedulerRunDue).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      completed: 0,
      failed: 0,
      skipped: 0,
      dueWorkRemaining: false,
    });
  });

  test("drain-due runs heartbeat when the local intent is due at wake", async () => {
    const dueAt = Date.now() - 1;
    computedIntent = intentFixture({
      nextWakeAt: dueAt,
      actualNextDueAt: dueAt,
      reason: "heartbeat",
    });
    const heartbeatRunManaged = mock(async () => ({
      due: true,
      completed: 1,
      skipped: 0,
    }));
    registerBackgroundWakeRuntime({
      heartbeat: {
        nextRunAt: dueAt,
        runManagedWakeIfDue: heartbeatRunManaged,
      },
      scheduler: {
        runOnce: mock(async () => 0),
        runDueWorkOnce: mock(async () => schedulerResultFixture()),
      },
    });
    const handler = findHandler("drainDueBackgroundWake");

    await handler({ body: drainBodyFixture({ reason: "refresh" }) });

    expect(heartbeatRunManaged).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledFor: NOW }),
    );
    expect(firstCallArg(heartbeatRunManaged)).not.toHaveProperty("assumeDue");
  });

  test("drain-due runs scheduler when schedule work is due at wake", async () => {
    const dueAt = Date.now() - 1;
    computedIntent = intentFixture({
      nextWakeAt: dueAt,
      actualNextDueAt: dueAt,
      reason: "schedule",
    });
    const schedulerRunDue = mock(async () =>
      schedulerResultFixture({ claimed: 1, completed: 1 }),
    );
    registerBackgroundWakeRuntime({
      heartbeat: {
        nextRunAt: Date.now() + 60_000,
        runManagedWakeIfDue: mock(async () => ({
          due: false,
          completed: 0,
          skipped: 0,
        })),
      },
      scheduler: {
        runOnce: mock(async () => 1),
        runDueWorkOnce: schedulerRunDue,
      },
    });
    const handler = findHandler("drainDueBackgroundWake");

    const response = await handler({
      body: drainBodyFixture({ reason: "refresh" }),
    });

    expect(schedulerRunDue).toHaveBeenCalledTimes(1);
    expect(response).toMatchObject({
      completed: 1,
      failed: 0,
      skipped: 0,
    });
  });

  test("drain-due runs due heartbeat even when schedule is the earliest intent source", async () => {
    const now = Date.now();
    const scheduleDueAt = now - 60_000;
    const heartbeatDueAt = now - 1_000;
    const recomputedIntent = intentFixture({
      nextWakeAt: now + 60_000,
      sourceGeneration: "after-mixed-backlog",
    });
    computedIntent = intentFixture({
      nextWakeAt: scheduleDueAt,
      actualNextDueAt: scheduleDueAt,
      reason: "schedule",
    });
    const heartbeatRunManaged = mock(async () => ({
      due: true,
      completed: 1,
      skipped: 0,
    }));
    const schedulerRunDue = mock(async () => {
      computedIntent = recomputedIntent;
      return schedulerResultFixture({ claimed: 1, completed: 1 });
    });
    registerBackgroundWakeRuntime({
      heartbeat: {
        nextRunAt: heartbeatDueAt,
        runManagedWakeIfDue: heartbeatRunManaged,
      },
      scheduler: {
        runOnce: mock(async () => 1),
        runDueWorkOnce: schedulerRunDue,
      },
    });
    const handler = findHandler("drainDueBackgroundWake");

    const response = await handler({
      body: drainBodyFixture({ reason: "schedule" }),
    });

    expect(heartbeatRunManaged).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledFor: NOW }),
    );
    expect(schedulerRunDue).toHaveBeenCalledTimes(1);
    expect(response).toMatchObject({
      completed: 2,
      failed: 0,
      skipped: 0,
      dueWorkRemaining: false,
    });
  });

  test("drain-due does no work for refresh-only wakes with no due intent", async () => {
    const heartbeatRunManaged = mock(async () => ({
      due: true,
      completed: 1,
      skipped: 0,
    }));
    const schedulerRunDue = mock(async () =>
      schedulerResultFixture({ completed: 1 }),
    );
    registerBackgroundWakeRuntime({
      heartbeat: {
        nextRunAt: Date.now() + 60_000,
        runManagedWakeIfDue: heartbeatRunManaged,
      },
      scheduler: {
        runOnce: mock(async () => 1),
        runDueWorkOnce: schedulerRunDue,
      },
    });
    const handler = findHandler("drainDueBackgroundWake");

    const response = await handler({
      body: drainBodyFixture({ reason: "refresh" }),
    });

    expect(heartbeatRunManaged).not.toHaveBeenCalled();
    expect(schedulerRunDue).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      completed: 0,
      failed: 0,
      skipped: 0,
      dueWorkRemaining: false,
    });
  });

  test("drain-due honors deadline exhaustion before starting heartbeat work", async () => {
    const dueAt = Date.now() - 1;
    computedIntent = intentFixture({
      nextWakeAt: dueAt,
      actualNextDueAt: dueAt,
      reason: "mixed",
    });
    const heartbeatRunManaged = mock(async () => ({
      due: true,
      completed: 1,
      skipped: 0,
    }));
    const schedulerRunDue = mock(async () =>
      schedulerResultFixture({ skipped: 2, stillPending: 2 }),
    );
    registerBackgroundWakeRuntime({
      heartbeat: {
        nextRunAt: dueAt,
        runManagedWakeIfDue: heartbeatRunManaged,
      },
      scheduler: {
        runOnce: mock(async () => 0),
        runDueWorkOnce: schedulerRunDue,
      },
    });
    const handler = findHandler("drainDueBackgroundWake");

    const response = await handler({
      body: drainBodyFixture({
        reason: "mixed",
        deadlineAt: Date.now() + 1_000,
      }),
    });

    expect(heartbeatRunManaged).not.toHaveBeenCalled();
    expect(schedulerRunDue).toHaveBeenCalledWith(
      expect.objectContaining({ minStartBudgetMs: 5_000 }),
    );
    expect(response).toMatchObject({
      completed: 0,
      failed: 0,
      skipped: 3,
      dueWorkRemaining: true,
    });
  });

  test("drain-due reports due work remaining from scheduler counts", async () => {
    const schedulerRunDue = mock(async () =>
      schedulerResultFixture({ claimed: 1, completed: 1, stillPending: 1 }),
    );
    registerBackgroundWakeRuntime({
      heartbeat: {
        nextRunAt: Date.now() + 60_000,
        runManagedWakeIfDue: mock(async () => ({
          due: false,
          completed: 0,
          skipped: 0,
        })),
      },
      scheduler: {
        runOnce: mock(async () => 1),
        runDueWorkOnce: schedulerRunDue,
      },
    });
    const handler = findHandler("drainDueBackgroundWake");

    const response = await handler({ body: drainBodyFixture() });

    expect(response).toMatchObject({
      completed: 1,
      failed: 0,
      skipped: 0,
      dueWorkRemaining: true,
    });
  });

  test("drain-due accepts vembda snake_case payload aliases", async () => {
    const schedulerRunDue = mock(async () => schedulerResultFixture());
    registerBackgroundWakeRuntime({
      heartbeat: {
        nextRunAt: null,
        runManagedWakeIfDue: mock(async () => ({
          due: false,
          completed: 0,
          skipped: 0,
        })),
      },
      scheduler: {
        runOnce: mock(async () => 0),
        runDueWorkOnce: schedulerRunDue,
      },
    });
    const handler = findHandler("drainDueBackgroundWake");

    const response = await handler({
      body: {
        lease_id: "lease-snake",
        reason: "refresh",
        source_generation: "generation-snake",
        started_at: new Date(NOW).toISOString(),
        deadline_at: String(NOW + 30_000),
      },
    });

    expect(response).toMatchObject({
      leaseId: "lease-snake",
      reason: "refresh",
      sourceGeneration: "generation-snake",
      startedAt: NOW,
      deadlineAt: NOW + 30_000,
    });
  });
});

function drainBodyFixture(
  overrides: Partial<{
    leaseId: string;
    reason: string;
    sourceGeneration: string;
    startedAt: number;
    deadlineAt: number;
  }> = {},
) {
  return {
    leaseId: "lease-123",
    reason: "schedule",
    sourceGeneration: "source-generation",
    startedAt: NOW,
    deadlineAt: NOW + 30_000,
    ...overrides,
  };
}

function intentFixture(overrides: Partial<MockIntent>): MockIntent {
  const nextWakeAt = overrides.nextWakeAt ?? NOW + 60_000;
  return {
    nextWakeAt,
    actualNextDueAt: nextWakeAt,
    reason: "schedule",
    sourceGeneration: "source-generation",
    computedAt: NOW - 1_000,
    sourcePayload: {
      heartbeat: null,
      schedules: [],
    },
    ...overrides,
  };
}
