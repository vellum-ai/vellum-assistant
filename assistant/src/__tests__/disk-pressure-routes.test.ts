import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { DiskUsageInfo } from "../util/disk-usage.js";

let diskSample: DiskUsageInfo | null = null;
const eventSubscribers = new Set<(event: unknown) => void>();

mock.module("../config/loader.js", () => ({
  getConfig: () => ({}),
}));

mock.module("../util/disk-usage.js", () => ({
  getDiskUsageInfo: () => diskSample,
}));

mock.module("../runtime/assistant-event.js", () => ({
  buildAssistantEvent: (message: unknown, conversationId?: string) => ({
    id: "event-test",
    type: "message",
    timestamp: new Date().toISOString(),
    conversationId,
    message,
  }),
}));

mock.module("../runtime/assistant-event-hub.js", () => ({
  AssistantEventHub: class {},
  broadcastMessage: () => {},
  capabilityForMessageType: () => undefined,
  assistantEventHub: {
    publish: async (event: unknown) => {
      for (const callback of eventSubscribers) callback(event);
    },
    subscribe: ({ callback }: { callback: (event: unknown) => void }) => {
      eventSubscribers.add(callback);
      return {
        dispose: () => {
          eventSubscribers.delete(callback);
        },
      };
    },
  },
}));

const { _setOverridesForTesting } =
  await import("../config/assistant-feature-flags.js");
const {
  DISK_PRESSURE_OVERRIDE_CONFIRMATION,
  DISK_PRESSURE_THRESHOLD_PERCENT,
  __resetDiskPressureGuardForTests,
  evaluateDiskPressureNow,
} = await import("../daemon/disk-pressure-guard.js");
const { assistantEventHub } = await import("../runtime/assistant-event-hub.js");
const { getPolicy } = await import("../runtime/auth/route-policy.js");
const { RouteError } = await import("../runtime/routes/errors.js");
const { ROUTES } = await import("../runtime/routes/disk-pressure-routes.js");

type DiskPressureRouteResult = {
  status: {
    enabled: boolean;
    state: string;
    locked: boolean;
    acknowledged: boolean;
    overrideActive: boolean;
    effectivelyLocked: boolean;
    lockId: string | null;
    usagePercent: number | null;
    thresholdPercent: number;
    path: string | null;
    lastCheckedAt: string | null;
    blockedCapabilities: string[];
    error: string | null;
  };
};

function setFeatureFlag(enabled: boolean): void {
  _setOverridesForTesting({ "safe-storage-limits": enabled });
}

function setDiskUsage(usedMb: number, totalMb = 100): void {
  diskSample = {
    path: "/workspace",
    totalMb,
    usedMb,
    freeMb: Math.max(0, totalMb - usedMb),
  };
}

function getRoute(endpoint: string, method: string) {
  const route = ROUTES.find(
    (r) => r.endpoint === endpoint && r.method === method,
  );
  if (!route) throw new Error(`${method} ${endpoint} route not registered`);
  return route;
}

async function callRoute(
  endpoint: string,
  method: string,
  body?: Record<string, unknown>,
): Promise<DiskPressureRouteResult> {
  return (await getRoute(endpoint, method).handler({
    body,
  })) as DiskPressureRouteResult;
}

function expectRouteError(
  error: unknown,
  code: string,
  statusCode: number,
): void {
  expect(error).toBeInstanceOf(RouteError);
  const routeError = error as { code: string; statusCode: number };
  expect(routeError.code).toBe(code);
  expect(routeError.statusCode).toBe(statusCode);
}

async function expectRouteRejects(
  endpoint: string,
  method: string,
  body: Record<string, unknown> | undefined,
  code: string,
  statusCode: number,
): Promise<void> {
  try {
    await callRoute(endpoint, method, body);
    throw new Error("Expected route to reject");
  } catch (error) {
    expectRouteError(error, code, statusCode);
  }
}

async function flushPublishedEvents(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  __resetDiskPressureGuardForTests();
  setFeatureFlag(true);
  setDiskUsage(10);
});

afterEach(() => {
  __resetDiskPressureGuardForTests();
  _setOverridesForTesting({});
  diskSample = null;
  eventSubscribers.clear();
});

describe("disk pressure routes", () => {
  test("registers routes and route auth policies", () => {
    for (const [endpoint, method] of [
      ["disk-pressure/status", "GET"],
      ["disk-pressure/acknowledge", "POST"],
      ["disk-pressure/override", "POST"],
    ] as const) {
      expect(
        ROUTES.some(
          (route) => route.endpoint === endpoint && route.method === method,
        ),
      ).toBe(true);
      expect(getPolicy(endpoint)).toBeDefined();
    }
  });

  test("returns disabled status without error when the feature flag is off", async () => {
    setFeatureFlag(false);
    setDiskUsage(99);

    const result = await callRoute("disk-pressure/status", "GET");

    expect(result.status).toMatchObject({
      enabled: false,
      state: "disabled",
      locked: false,
      acknowledged: false,
      overrideActive: false,
      effectivelyLocked: false,
      lockId: null,
      usagePercent: null,
      path: null,
      lastCheckedAt: null,
      blockedCapabilities: [],
      error: null,
    });
    expect(result.status.thresholdPercent).toBe(
      DISK_PRESSURE_THRESHOLD_PERCENT,
    );
  });

  test("returns the full status shape for an active lock", async () => {
    setDiskUsage(99);
    evaluateDiskPressureNow();

    const result = await callRoute("disk-pressure/status", "GET");

    expect(result.status.enabled).toBe(true);
    expect(result.status.state).toBe("critical");
    expect(result.status.locked).toBe(true);
    expect(result.status.acknowledged).toBe(false);
    expect(result.status.overrideActive).toBe(false);
    expect(result.status.effectivelyLocked).toBe(true);
    expect(result.status.lockId).toBeTruthy();
    expect(result.status.usagePercent).toBe(99);
    expect(result.status.thresholdPercent).toBe(
      DISK_PRESSURE_THRESHOLD_PERCENT,
    );
    expect(result.status.path).toBe("/workspace");
    expect(result.status.lastCheckedAt).toBeTruthy();
    expect(result.status.blockedCapabilities).toEqual([
      "agent-turns",
      "background-work",
      "remote-ingress",
    ]);
    expect(result.status.error).toBeNull();
  });

  test("returns cached status without sampling or emitting a read-path status event", async () => {
    const events: unknown[] = [];
    const subscription = assistantEventHub.subscribe({
      type: "process",
      callback: (event) => {
        if (event.message.type === "disk_pressure_status_changed") {
          events.push(event.message);
        }
      },
    });

    try {
      setDiskUsage(99);

      const result = await callRoute("disk-pressure/status", "GET");
      await flushPublishedEvents();

      expect(result.status.state).toBe("ok");
      expect(result.status.locked).toBe(false);
      expect(result.status.usagePercent).toBeNull();
      expect(events).toEqual([]);
    } finally {
      subscription.dispose();
    }
  });

  test("acknowledges an active lock without overriding it", async () => {
    setDiskUsage(99);
    evaluateDiskPressureNow();

    const result = await callRoute("disk-pressure/acknowledge", "POST");

    expect(result.status.acknowledged).toBe(true);
    expect(result.status.overrideActive).toBe(false);
    expect(result.status.effectivelyLocked).toBe(true);
  });

  test("overrides an active lock only after the confirmation phrase", async () => {
    setDiskUsage(99);
    evaluateDiskPressureNow();

    const result = await callRoute("disk-pressure/override", "POST", {
      confirmation: DISK_PRESSURE_OVERRIDE_CONFIRMATION,
    });

    expect(result.status.locked).toBe(true);
    expect(result.status.overrideActive).toBe(true);
    expect(result.status.effectivelyLocked).toBe(false);
  });

  test("rejects an invalid override phrase with INVALID_CONFIRMATION", async () => {
    setDiskUsage(99);
    evaluateDiskPressureNow();

    await expectRouteRejects(
      "disk-pressure/override",
      "POST",
      { confirmation: "I accept the risks" },
      "INVALID_CONFIRMATION",
      400,
    );
  });

  test("rejects acknowledgement and override when no lock is active", async () => {
    setDiskUsage(10);
    evaluateDiskPressureNow();

    await expectRouteRejects(
      "disk-pressure/acknowledge",
      "POST",
      undefined,
      "NOT_LOCKED",
      409,
    );
    await expectRouteRejects(
      "disk-pressure/override",
      "POST",
      { confirmation: DISK_PRESSURE_OVERRIDE_CONFIRMATION },
      "NOT_LOCKED",
      409,
    );
  });

  test("rejects repeated acknowledgement", async () => {
    setDiskUsage(99);
    evaluateDiskPressureNow();
    await callRoute("disk-pressure/acknowledge", "POST");

    await expectRouteRejects(
      "disk-pressure/acknowledge",
      "POST",
      undefined,
      "ALREADY_ACKNOWLEDGED",
      409,
    );
  });

  test("rejects repeated override", async () => {
    setDiskUsage(99);
    evaluateDiskPressureNow();
    await callRoute("disk-pressure/override", "POST", {
      confirmation: DISK_PRESSURE_OVERRIDE_CONFIRMATION,
    });

    await expectRouteRejects(
      "disk-pressure/override",
      "POST",
      { confirmation: DISK_PRESSURE_OVERRIDE_CONFIRMATION },
      "ALREADY_OVERRIDDEN",
      409,
    );
  });

  test("emits typed status-change events for lock, acknowledgement, override, usage, and unlock changes", async () => {
    const events: unknown[] = [];
    const subscription = assistantEventHub.subscribe({
      type: "process",
      callback: (event) => {
        if (event.message.type === "disk_pressure_status_changed") {
          events.push(event.message);
        }
      },
    });

    try {
      setDiskUsage(99);
      evaluateDiskPressureNow();
      await callRoute("disk-pressure/acknowledge", "POST");
      await callRoute("disk-pressure/override", "POST", {
        confirmation: DISK_PRESSURE_OVERRIDE_CONFIRMATION,
      });
      setDiskUsage(98);
      evaluateDiskPressureNow();
      setDiskUsage(10);
      evaluateDiskPressureNow();
      await flushPublishedEvents();
    } finally {
      subscription.dispose();
    }

    const statuses = events.map(
      (message) =>
        (message as { status: DiskPressureRouteResult["status"] }).status,
    );
    expect(statuses.map((status) => status.state)).toEqual([
      "critical",
      "critical",
      "critical",
      "critical",
      "ok",
    ]);
    expect(statuses[0].enabled).toBe(true);
    expect(statuses[1].acknowledged).toBe(true);
    expect(statuses[1].overrideActive).toBe(false);
    expect(statuses[2].overrideActive).toBe(true);
    expect(statuses[2].effectivelyLocked).toBe(false);
    expect(statuses[3].usagePercent).toBe(98);
    expect(statuses[4].locked).toBe(false);
    expect(statuses[4].lockId).toBeNull();
  });
});
