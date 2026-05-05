import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const warnCalls: unknown[] = [];
let guardEnabled = true;
let startCalls = 0;
let stopCalls = 0;
let evaluateCalls = 0;
let evaluateError: string | null = null;

function makeOpenStatus() {
  return {
    enabled: true,
    state: "ok",
    locked: false,
    acknowledged: false,
    overrideActive: false,
    effectivelyLocked: false,
    lockId: null,
    usagePercent: 10,
    thresholdPercent: 95,
    path: "/workspace",
    lastCheckedAt: new Date().toISOString(),
    blockedCapabilities: [],
    error: null,
  };
}

mock.module("../daemon/disk-pressure-guard.js", () => ({
  startDiskPressureGuard: () => {
    startCalls += 1;
    return {
      enabled: guardEnabled,
      state: guardEnabled ? "ok" : "disabled",
      locked: false,
      acknowledged: false,
      overrideActive: false,
      effectivelyLocked: false,
      lockId: null,
      usagePercent: null,
      thresholdPercent: 95,
      path: null,
      lastCheckedAt: null,
      blockedCapabilities: [],
      error: null,
    };
  },
  stopDiskPressureGuard: () => {
    stopCalls += 1;
  },
  evaluateDiskPressureNow: () => {
    evaluateCalls += 1;
    return {
      enabled: true,
      state: evaluateError ? "unknown" : "ok",
      locked: false,
      acknowledged: false,
      overrideActive: false,
      effectivelyLocked: false,
      lockId: null,
      usagePercent: evaluateError ? null : 10,
      thresholdPercent: 95,
      path: evaluateError ? null : "/workspace",
      lastCheckedAt: new Date().toISOString(),
      blockedCapabilities: [],
      error: evaluateError,
    };
  },
  getDiskPressureStatus: () => makeOpenStatus(),
  acknowledgeDiskPressureLock: () => ({
    ok: false,
    reason: "not_locked",
    message: "No disk pressure lock is active for this assistant.",
    status: makeOpenStatus(),
  }),
  overrideDiskPressureLock: () => ({
    ok: false,
    reason: "not_locked",
    message: "No disk pressure lock is active for this assistant.",
    status: makeOpenStatus(),
  }),
  DISK_PRESSURE_OVERRIDE_CONFIRMATION: "I understand the risks",
}));

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    debug: () => {},
    error: () => {},
    info: () => {},
    warn: (...args: unknown[]) => {
      warnCalls.push(args);
    },
  }),
  initLogger: () => {},
}));

const {
  startDiskPressureGuardForLifecycle,
  stopDiskPressureGuardForLifecycle,
} = await import("../daemon/lifecycle.js");

async function flushStartupSample(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  guardEnabled = true;
  startCalls = 0;
  stopCalls = 0;
  evaluateCalls = 0;
  evaluateError = null;
  warnCalls.length = 0;
});

afterEach(() => {
  stopDiskPressureGuardForLifecycle();
  guardEnabled = true;
  evaluateError = null;
  warnCalls.length = 0;
});

describe("disk pressure guard lifecycle", () => {
  test("starts once and evaluates off the startup path when enabled", async () => {
    startDiskPressureGuardForLifecycle();

    expect(startCalls).toBe(1);
    expect(evaluateCalls).toBe(0);

    startDiskPressureGuardForLifecycle();
    expect(startCalls).toBe(2);
    expect(evaluateCalls).toBe(0);

    await flushStartupSample();

    expect(evaluateCalls).toBe(1);
  });

  test("stays inert when the feature flag is disabled", async () => {
    guardEnabled = false;

    startDiskPressureGuardForLifecycle();
    await flushStartupSample();

    expect(startCalls).toBe(1);
    expect(evaluateCalls).toBe(0);
  });

  test("logs sample failures and leaves startup unlocked", async () => {
    evaluateError = "sample failed";

    expect(() => startDiskPressureGuardForLifecycle()).not.toThrow();
    expect(evaluateCalls).toBe(0);

    await flushStartupSample();

    expect(evaluateCalls).toBe(1);
    expect(warnCalls.length).toBe(1);
  });

  test("stop clears pending startup sample and stops the guard", async () => {
    startDiskPressureGuardForLifecycle();

    stopDiskPressureGuardForLifecycle();
    await flushStartupSample();

    expect(evaluateCalls).toBe(0);
    expect(stopCalls).toBe(1);
  });
});
