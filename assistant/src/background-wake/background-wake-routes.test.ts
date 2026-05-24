import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

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
    const heartbeatRunOnce = mock(async () => true);
    const schedulerRunOnce = mock(async () => 2);
    registerBackgroundWakeRuntime({
      heartbeat: {
        nextRunAt: Date.now() - 1,
        runOnce: heartbeatRunOnce,
      },
      scheduler: {
        runOnce: schedulerRunOnce,
      },
    });
    computedIntent = intentFixture({
      nextWakeAt: NOW + 60_000,
      sourceGeneration: "next-generation",
    });
    const handler = findHandler("drainDueBackgroundWake");

    const response = await handler({ body: drainBodyFixture() });

    expect(heartbeatRunOnce).toHaveBeenCalledTimes(1);
    expect(heartbeatRunOnce).toHaveBeenCalledWith();
    expect(schedulerRunOnce).toHaveBeenCalledTimes(1);
    expect(response).toEqual({
      leaseId: "lease-123",
      reason: "schedule",
      sourceGeneration: "source-generation",
      startedAt: NOW,
      deadlineAt: NOW + 30_000,
      counts: {
        heartbeat: 1,
        scheduler: 2,
        total: 3,
      },
      nextIntent: computedIntent,
    });
  });

  test("drain-due skips heartbeat when it is not due and reports no scheduler work", async () => {
    const heartbeatRunOnce = mock(async () => true);
    const schedulerRunOnce = mock(async () => 0);
    registerBackgroundWakeRuntime({
      heartbeat: {
        nextRunAt: Date.now() + 5 * 60_000,
        runOnce: heartbeatRunOnce,
      },
      scheduler: {
        runOnce: schedulerRunOnce,
      },
    });
    const handler = findHandler("drainDueBackgroundWake");

    const response = (await handler({ body: drainBodyFixture() })) as {
      counts: { heartbeat: number; scheduler: number; total: number };
    };

    expect(heartbeatRunOnce).not.toHaveBeenCalled();
    expect(schedulerRunOnce).toHaveBeenCalledTimes(1);
    expect(response.counts).toEqual({
      heartbeat: 0,
      scheduler: 0,
      total: 0,
    });
  });

  test("drain-due recomputes the next intent after due work drains", async () => {
    const recomputedIntent = intentFixture({
      nextWakeAt: NOW + 2 * 60_000,
      sourceGeneration: "after-drain",
    });
    const schedulerRunOnce = mock(async () => {
      computedIntent = recomputedIntent;
      return 1;
    });
    registerBackgroundWakeRuntime({
      heartbeat: {
        nextRunAt: null,
        runOnce: mock(async () => true),
      },
      scheduler: {
        runOnce: schedulerRunOnce,
      },
    });
    const handler = findHandler("drainDueBackgroundWake");

    const response = (await handler({ body: drainBodyFixture() })) as {
      nextIntent: MockIntent | null;
    };

    expect(response.nextIntent).toEqual(recomputedIntent);
  });

  test("drain-due accepts vembda snake_case payload aliases", async () => {
    const schedulerRunOnce = mock(async () => 0);
    registerBackgroundWakeRuntime({
      heartbeat: {
        nextRunAt: null,
        runOnce: mock(async () => false),
      },
      scheduler: {
        runOnce: schedulerRunOnce,
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

function drainBodyFixture() {
  return {
    leaseId: "lease-123",
    reason: "schedule",
    sourceGeneration: "source-generation",
    startedAt: NOW,
    deadlineAt: NOW + 30_000,
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
