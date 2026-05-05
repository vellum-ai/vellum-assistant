import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { DiskPressureTransitionResult } from "../daemon/disk-pressure-guard.js";
import type { DiskUsageInfo } from "../util/disk-usage.js";

let diskSample: DiskUsageInfo | null = null;
let diskSampleError: unknown = null;
let diskSampleCalls = 0;

mock.module("../config/loader.js", () => ({
  getConfig: () => ({}),
}));

mock.module("../util/disk-usage.js", () => ({
  getDiskUsageInfo: () => {
    diskSampleCalls += 1;
    if (diskSampleError) throw diskSampleError;
    return diskSample;
  },
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
    publish: async () => {},
  },
}));

const { _setOverridesForTesting } =
  await import("../config/assistant-feature-flags.js");
const {
  DISK_PRESSURE_OVERRIDE_CONFIRMATION,
  DISK_PRESSURE_THRESHOLD_PERCENT,
  __getDiskPressureGuardTimerForTests,
  __resetDiskPressureGuardForTests,
  acknowledgeDiskPressureLock,
  evaluateDiskPressureNow,
  getDiskPressureStatus,
  overrideDiskPressureLock,
  startDiskPressureGuard,
  stopDiskPressureGuard,
} = await import("../daemon/disk-pressure-guard.js");

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
  diskSampleError = null;
}

function expectRejected(
  result: DiskPressureTransitionResult,
  reason: Exclude<DiskPressureTransitionResult, { ok: true }>["reason"],
): asserts result is Exclude<DiskPressureTransitionResult, { ok: true }> {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("Expected disk pressure transition to be rejected");
  }
  expect(result.reason).toBe(reason);
}

beforeEach(() => {
  __resetDiskPressureGuardForTests();
  setFeatureFlag(true);
  setDiskUsage(10);
  diskSampleCalls = 0;
});

afterEach(() => {
  __resetDiskPressureGuardForTests();
  _setOverridesForTesting({});
  diskSample = null;
  diskSampleError = null;
  diskSampleCalls = 0;
});

describe("disk pressure guard", () => {
  test("returns a stable disabled status without sampling when the flag is disabled", () => {
    setDiskUsage(99);
    setFeatureFlag(false);

    const status = evaluateDiskPressureNow();

    expect(status.enabled).toBe(false);
    expect(status.state).toBe("disabled");
    expect(status.locked).toBe(false);
    expect(status.effectivelyLocked).toBe(false);
    expect(status.usagePercent).toBeNull();
    expect(diskSampleCalls).toBe(0);
    expect(getDiskPressureStatus()).toEqual(status);
  });

  test("locks when sampled usage reaches the threshold", () => {
    setDiskUsage(DISK_PRESSURE_THRESHOLD_PERCENT);

    const status = evaluateDiskPressureNow();

    expect(status.enabled).toBe(true);
    expect(status.state).toBe("critical");
    expect(status.locked).toBe(true);
    expect(status.acknowledged).toBe(false);
    expect(status.overrideActive).toBe(false);
    expect(status.effectivelyLocked).toBe(true);
    expect(status.lockId).toBeTruthy();
    expect(status.usagePercent).toBe(DISK_PRESSURE_THRESHOLD_PERCENT);
    expect(status.thresholdPercent).toBe(DISK_PRESSURE_THRESHOLD_PERCENT);
    expect(status.path).toBe("/workspace");
    expect(status.lastCheckedAt).toBeTruthy();
    expect(status.blockedCapabilities.length).toBeGreaterThan(0);
  });

  test("acknowledges an active lock without overriding it", () => {
    setDiskUsage(99);
    evaluateDiskPressureNow();

    const result = acknowledgeDiskPressureLock();

    expect(result.ok).toBe(true);
    expect(result.status.acknowledged).toBe(true);
    expect(result.status.overrideActive).toBe(false);
    expect(result.status.effectivelyLocked).toBe(true);
  });

  test("unlocks and clears acknowledgement and override when usage falls below threshold", () => {
    setDiskUsage(99);
    evaluateDiskPressureNow();
    acknowledgeDiskPressureLock();
    overrideDiskPressureLock(DISK_PRESSURE_OVERRIDE_CONFIRMATION);

    setDiskUsage(20);
    const status = evaluateDiskPressureNow();

    expect(status.state).toBe("ok");
    expect(status.locked).toBe(false);
    expect(status.acknowledged).toBe(false);
    expect(status.overrideActive).toBe(false);
    expect(status.effectivelyLocked).toBe(false);
    expect(status.lockId).toBeNull();
    expect(status.blockedCapabilities).toEqual([]);
  });

  test("overrides an active lock only with the exact confirmation after trimming whitespace", () => {
    setDiskUsage(99);
    evaluateDiskPressureNow();

    const invalid = overrideDiskPressureLock("I accept the risks");
    expectRejected(invalid, "invalid_confirmation");
    expect(invalid.status.effectivelyLocked).toBe(true);

    const valid = overrideDiskPressureLock(
      `  ${DISK_PRESSURE_OVERRIDE_CONFIRMATION}  `,
    );

    expect(valid.ok).toBe(true);
    expect(valid.status.locked).toBe(true);
    expect(valid.status.overrideActive).toBe(true);
    expect(valid.status.effectivelyLocked).toBe(false);
  });

  test("rejects acknowledgement when no lock is active", () => {
    setDiskUsage(10);
    evaluateDiskPressureNow();

    const result = acknowledgeDiskPressureLock();

    expectRejected(result, "not_locked");
    expect(result.status.locked).toBe(false);
  });

  test("rejects override when no lock is active", () => {
    setDiskUsage(10);
    evaluateDiskPressureNow();

    const result = overrideDiskPressureLock(
      DISK_PRESSURE_OVERRIDE_CONFIRMATION,
    );

    expectRejected(result, "not_locked");
    expect(result.status.locked).toBe(false);
  });

  test("rejects repeated override while preserving the existing override", () => {
    setDiskUsage(99);
    evaluateDiskPressureNow();
    const first = overrideDiskPressureLock(DISK_PRESSURE_OVERRIDE_CONFIRMATION);
    expect(first.ok).toBe(true);

    const second = overrideDiskPressureLock(
      DISK_PRESSURE_OVERRIDE_CONFIRMATION,
    );

    expectRejected(second, "already_overridden");
    expect(second.status.overrideActive).toBe(true);
    expect(second.status.effectivelyLocked).toBe(false);
  });

  test("sample failures degrade open and do not preserve a prior lock", () => {
    setDiskUsage(99);
    evaluateDiskPressureNow();
    expect(getDiskPressureStatus().locked).toBe(true);

    diskSampleError = new Error("sample failed");
    const status = evaluateDiskPressureNow();

    expect(status.enabled).toBe(true);
    expect(status.state).toBe("unknown");
    expect(status.locked).toBe(false);
    expect(status.effectivelyLocked).toBe(false);
    expect(status.error).toBe("sample failed");
    expect(status.lastCheckedAt).toBeTruthy();
  });

  test("timer start and stop are idempotent", () => {
    expect(__getDiskPressureGuardTimerForTests()).toBeNull();

    startDiskPressureGuard();
    const firstTimer = __getDiskPressureGuardTimerForTests();
    expect(firstTimer).toBeTruthy();

    startDiskPressureGuard();
    expect(__getDiskPressureGuardTimerForTests()).toBe(firstTimer);

    stopDiskPressureGuard();
    expect(__getDiskPressureGuardTimerForTests()).toBeNull();

    stopDiskPressureGuard();
    expect(__getDiskPressureGuardTimerForTests()).toBeNull();
  });

  test("disabling the flag clears an active timer and lock", () => {
    setDiskUsage(99);
    evaluateDiskPressureNow();
    startDiskPressureGuard();
    expect(__getDiskPressureGuardTimerForTests()).toBeTruthy();

    setFeatureFlag(false);
    const status = evaluateDiskPressureNow();

    expect(status.enabled).toBe(false);
    expect(status.locked).toBe(false);
    expect(__getDiskPressureGuardTimerForTests()).toBeNull();
  });
});
