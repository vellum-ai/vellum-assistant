import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { HeartbeatService } from "../heartbeat/heartbeat-service.js";
import type {
  SchedulerDueWorkResult,
  SchedulerHandle,
} from "../schedule/scheduler.js";
import type { BackgroundWakeIntent } from "./next-wake.js";

// The drain-due route resolves the scheduler and heartbeat from their
// singletons; mock those accessors so each test can inject the doubles it
// asserts against. next-wake.ts also reads HeartbeatService.getInstance(), so
// the heartbeat mock exposes that too.
type BackgroundWakeRuntime = {
  scheduler: Pick<SchedulerHandle, "runOnce" | "runDueWorkOnce">;
  heartbeat: Pick<HeartbeatService, "nextRunAt" | "runManagedWakeIfDue">;
};

let mockScheduler: BackgroundWakeRuntime["scheduler"] | null = null;
let mockHeartbeat: BackgroundWakeRuntime["heartbeat"] | null = null;

mock.module("../schedule/scheduler.js", () => ({
  getScheduler: () => mockScheduler,
}));
mock.module("../heartbeat/heartbeat-service.js", () => ({
  getHeartbeatService: () => mockHeartbeat,
  HeartbeatService: { getInstance: () => mockHeartbeat },
}));

function setBackgroundWakeRuntime(runtime: BackgroundWakeRuntime): void {
  mockScheduler = runtime.scheduler;
  mockHeartbeat = runtime.heartbeat;
}

function clearBackgroundWakeRuntime(): void {
  mockScheduler = null;
  mockHeartbeat = null;
}

type MockIntent = BackgroundWakeIntent;
type MockCompletionPayload = {
  leaseId: string;
  status: "completed" | "failed" | "expired";
  error?: string;
  nextIntent?: MockIntent | null;
};

let computedIntent: MockIntent | null;
let computeCalls: number;
const mockRenewBackgroundWakeLease = mock(async (_leaseId: string) => ({
  status: "renewed" as const,
  httpStatus: 200,
}));
const mockCompleteBackgroundWakeLease = mock(
  async (_args: MockCompletionPayload) => ({
    status: "completed" as const,
    httpStatus: 200,
  }),
);

const {
  ROUTES,
  flushBackgroundWakeDrainsForTest,
  setBackgroundWakeIntentComputerForTest,
  setBackgroundWakeLeaseClientForTest,
} = await import("../runtime/routes/background-wake-routes.js");

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
    ...overrides,
  };
}

function firstCallArg(fn: {
  mock: { calls: unknown[] };
}): Record<string, unknown> {
  const call = fn.mock.calls[0] as unknown[] | undefined;
  return (call?.[0] ?? {}) as Record<string, unknown>;
}

function acceptedResponse(
  overrides: Partial<{
    leaseId: string;
    reason: string;
    sourceGeneration: string;
    startedAt: number;
    deadlineAt: number;
  }> = {},
) {
  return {
    accepted: true,
    leaseId: "lease-123",
    reason: "schedule",
    sourceGeneration: "source-generation",
    startedAt: NOW,
    deadlineAt: NOW + 30_000,
    ...overrides,
  };
}

function lastCompletionPayload(): MockCompletionPayload {
  const calls = mockCompleteBackgroundWakeLease.mock.calls;
  const call = calls[calls.length - 1] as unknown[] | undefined;
  if (!call) throw new Error("completeBackgroundWakeLease was not called");
  return call[0] as MockCompletionPayload;
}

describe("background wake runtime routes", () => {
  beforeEach(() => {
    clearBackgroundWakeRuntime();
    mockRenewBackgroundWakeLease.mockClear();
    mockCompleteBackgroundWakeLease.mockClear();
    mockRenewBackgroundWakeLease.mockImplementation(
      async (_leaseId: string) => ({
        status: "renewed" as const,
        httpStatus: 200,
      }),
    );
    mockCompleteBackgroundWakeLease.mockImplementation(
      async (_args: MockCompletionPayload) => ({
        status: "completed" as const,
        httpStatus: 200,
      }),
    );
    setBackgroundWakeLeaseClientForTest({
      renew: mockRenewBackgroundWakeLease,
      complete: mockCompleteBackgroundWakeLease,
    });
    computeCalls = 0;
    computedIntent = intentFixture({ nextWakeAt: Date.now() + 10 * 60_000 });
    setBackgroundWakeIntentComputerForTest(() => {
      computeCalls += 1;
      return computedIntent;
    });
  });

  afterEach(async () => {
    await flushBackgroundWakeDrainsForTest();
    setBackgroundWakeIntentComputerForTest(null);
    setBackgroundWakeLeaseClientForTest(null);
    clearBackgroundWakeRuntime();
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

  test("drain-due fails when the scheduler or heartbeat is unavailable", async () => {
    const handler = findHandler("drainDueBackgroundWake");

    await expect(handler({ body: drainBodyFixture() })).rejects.toThrow(
      "Background wake runtime is not available",
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
    setBackgroundWakeRuntime({
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
    await flushBackgroundWakeDrainsForTest();

    expect(heartbeatRunManaged).toHaveBeenCalledTimes(1);
    expect(heartbeatRunManaged).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledFor: NOW }),
    );
    expect(firstCallArg(heartbeatRunManaged)).not.toHaveProperty("assumeDue");
    expect(schedulerRunDue).toHaveBeenCalledTimes(1);
    expect(response).toEqual(acceptedResponse({ reason: "mixed" }));
    expect(lastCompletionPayload()).toEqual({
      leaseId: "lease-123",
      status: "completed",
      nextIntent: recomputedIntent,
    });
  });

  test("drain-due skips heartbeat when it is not due and reports no scheduler work", async () => {
    const heartbeatRunManaged = mock(async () => ({
      due: true,
      completed: 1,
      skipped: 0,
    }));
    const schedulerRunDue = mock(async () => schedulerResultFixture());
    setBackgroundWakeRuntime({
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

    const response = await handler({ body: drainBodyFixture() });
    await flushBackgroundWakeDrainsForTest();

    expect(heartbeatRunManaged).not.toHaveBeenCalled();
    expect(schedulerRunDue).toHaveBeenCalledTimes(1);
    expect(response).toEqual(acceptedResponse());
    expect(lastCompletionPayload()).toMatchObject({
      leaseId: "lease-123",
      status: "completed",
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
    setBackgroundWakeRuntime({
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

    const response = await handler({ body: drainBodyFixture() });
    await flushBackgroundWakeDrainsForTest();

    expect(response).toEqual(acceptedResponse());
    expect(lastCompletionPayload().nextIntent).toEqual(recomputedIntent);
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
    setBackgroundWakeRuntime({
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
    await flushBackgroundWakeDrainsForTest();

    expect(heartbeatRunManaged).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduledFor: NOW,
      }),
    );
    expect(firstCallArg(heartbeatRunManaged)).not.toHaveProperty("assumeDue");
    expect(schedulerRunDue).toHaveBeenCalledTimes(1);
    expect(response).toEqual(acceptedResponse({ reason: "heartbeat" }));
    expect(lastCompletionPayload()).toMatchObject({
      leaseId: "lease-123",
      status: "completed",
      nextIntent: recomputedIntent,
    });
  });

  test("drain-due does not rerun heartbeat for stale heartbeat drain requests", async () => {
    const heartbeatRunManaged = mock(async () => ({
      due: true,
      completed: 1,
      skipped: 0,
    }));
    const schedulerRunDue = mock(async () => schedulerResultFixture());
    setBackgroundWakeRuntime({
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
    await flushBackgroundWakeDrainsForTest();

    expect(heartbeatRunManaged).not.toHaveBeenCalled();
    expect(schedulerRunDue).not.toHaveBeenCalled();
    expect(response).toEqual(acceptedResponse({ reason: "heartbeat" }));
    expect(lastCompletionPayload()).toMatchObject({
      leaseId: "lease-123",
      status: "completed",
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
    setBackgroundWakeRuntime({
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

    const response = await handler({
      body: drainBodyFixture({ reason: "refresh" }),
    });
    await flushBackgroundWakeDrainsForTest();

    expect(heartbeatRunManaged).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledFor: NOW }),
    );
    expect(firstCallArg(heartbeatRunManaged)).not.toHaveProperty("assumeDue");
    expect(response).toEqual(acceptedResponse({ reason: "refresh" }));
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
    setBackgroundWakeRuntime({
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
    await flushBackgroundWakeDrainsForTest();

    expect(schedulerRunDue).toHaveBeenCalledTimes(1);
    expect(response).toEqual(acceptedResponse({ reason: "refresh" }));
    expect(lastCompletionPayload()).toMatchObject({
      leaseId: "lease-123",
      status: "completed",
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
    setBackgroundWakeRuntime({
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
    await flushBackgroundWakeDrainsForTest();

    expect(heartbeatRunManaged).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledFor: NOW }),
    );
    expect(schedulerRunDue).toHaveBeenCalledTimes(1);
    expect(response).toEqual(acceptedResponse({ reason: "schedule" }));
    expect(lastCompletionPayload()).toMatchObject({
      leaseId: "lease-123",
      status: "completed",
      nextIntent: recomputedIntent,
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
    setBackgroundWakeRuntime({
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
    await flushBackgroundWakeDrainsForTest();

    expect(heartbeatRunManaged).not.toHaveBeenCalled();
    expect(schedulerRunDue).not.toHaveBeenCalled();
    expect(response).toEqual(acceptedResponse({ reason: "refresh" }));
    expect(lastCompletionPayload()).toMatchObject({
      leaseId: "lease-123",
      status: "completed",
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
      schedulerResultFixture({ skipped: 2 }),
    );
    setBackgroundWakeRuntime({
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
    await flushBackgroundWakeDrainsForTest();

    expect(heartbeatRunManaged).not.toHaveBeenCalled();
    expect(schedulerRunDue).toHaveBeenCalledWith(
      expect.objectContaining({ minStartBudgetMs: 5_000 }),
    );
    expect(response).toMatchObject({
      accepted: true,
      reason: "mixed",
    });
    expect(lastCompletionPayload()).toMatchObject({
      leaseId: "lease-123",
      status: "completed",
    });
  });

  test("drain-due completes expired without starting when the lease deadline already elapsed", async () => {
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
      schedulerResultFixture({ claimed: 1, completed: 1 }),
    );
    setBackgroundWakeRuntime({
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
      body: drainBodyFixture({
        reason: "mixed",
        deadlineAt: Date.now() - 1,
      }),
    });
    await flushBackgroundWakeDrainsForTest();

    expect(heartbeatRunManaged).not.toHaveBeenCalled();
    expect(schedulerRunDue).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      accepted: true,
      reason: "mixed",
    });
    expect(lastCompletionPayload()).toMatchObject({
      leaseId: "lease-123",
      status: "expired",
      error: "background wake lease deadline elapsed before starting work",
    });
  });

  test("drain-due keeps a lease active until slow work settles after the original deadline", async () => {
    const schedulerResolvers: Array<() => void> = [];
    const schedulerRunDue = mock(async () => {
      await new Promise<void>((resolve) => schedulerResolvers.push(resolve));
      return schedulerResultFixture({ claimed: 1, completed: 1 });
    });
    setBackgroundWakeRuntime({
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
    // Keep the deadline far enough ahead that the synchronous start-check always
    // sees it as live; the wait below outlasts it, so completion is verified to
    // hold until the work settles rather than fire when the deadline elapses.
    const deadlineAt = Date.now() + 200;

    const firstResponse = await handler({
      body: drainBodyFixture({
        leaseId: "lease-long-running",
        deadlineAt,
      }),
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 280));
      expect(mockCompleteBackgroundWakeLease).not.toHaveBeenCalled();

      const duplicateResponse = await handler({
        body: drainBodyFixture({
          leaseId: "lease-long-running",
          deadlineAt,
        }),
      });

      expect(firstResponse).toMatchObject({
        accepted: true,
        leaseId: "lease-long-running",
      });
      expect(duplicateResponse).toMatchObject({
        accepted: true,
        leaseId: "lease-long-running",
      });
      expect(schedulerRunDue).toHaveBeenCalledTimes(1);
    } finally {
      for (const resolve of schedulerResolvers) resolve();
    }

    await flushBackgroundWakeDrainsForTest();
    expect(schedulerRunDue).toHaveBeenCalledTimes(1);
    expect(mockCompleteBackgroundWakeLease).toHaveBeenCalledTimes(1);
    expect(lastCompletionPayload()).toMatchObject({
      leaseId: "lease-long-running",
      status: "completed",
    });
  });

  test("drain-due runs scheduler work even when pending work remains", async () => {
    const schedulerRunDue = mock(async () =>
      schedulerResultFixture({ claimed: 1, completed: 1 }),
    );
    setBackgroundWakeRuntime({
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
    await flushBackgroundWakeDrainsForTest();

    expect(schedulerRunDue).toHaveBeenCalledTimes(1);
    expect(response).toEqual(acceptedResponse());
    expect(lastCompletionPayload()).toMatchObject({
      leaseId: "lease-123",
      status: "completed",
    });
  });

  test("drain-due completes failed when due work throws", async () => {
    const schedulerRunDue = mock(async () => {
      throw new Error("scheduler exploded");
    });
    setBackgroundWakeRuntime({
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

    const response = await handler({ body: drainBodyFixture() });
    await flushBackgroundWakeDrainsForTest();

    expect(response).toEqual(acceptedResponse());
    expect(lastCompletionPayload()).toMatchObject({
      leaseId: "lease-123",
      status: "failed",
      error: "scheduler exploded",
    });
  });

  test("drain-due does not reclassify successful work when completion reporting fails", async () => {
    const completionError = new Error("platform unavailable");
    mockCompleteBackgroundWakeLease.mockImplementation(async (args) => {
      if (args.status === "completed" || args.status === "expired") {
        throw completionError;
      }
      return { status: "completed" as const, httpStatus: 200 };
    });
    const schedulerRunDue = mock(async () => schedulerResultFixture());
    setBackgroundWakeRuntime({
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

    const response = await handler({ body: drainBodyFixture() });
    await flushBackgroundWakeDrainsForTest();

    expect(response).toEqual(acceptedResponse());
    expect(mockCompleteBackgroundWakeLease).toHaveBeenCalledTimes(1);
    expect(lastCompletionPayload()).toMatchObject({
      leaseId: "lease-123",
      status: "completed",
    });
  });

  test("drain-due accepts vembda snake_case payload aliases", async () => {
    const schedulerRunDue = mock(async () => schedulerResultFixture());
    setBackgroundWakeRuntime({
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
    await flushBackgroundWakeDrainsForTest();

    expect(response).toMatchObject({
      accepted: true,
      leaseId: "lease-snake",
      reason: "refresh",
      sourceGeneration: "generation-snake",
      startedAt: NOW,
      deadlineAt: NOW + 30_000,
    });
    expect(lastCompletionPayload()).toMatchObject({
      leaseId: "lease-snake",
      status: "completed",
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
