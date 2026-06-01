import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { DiskPressureTransitionResult } from "../daemon/disk-pressure-guard.js";
import type { DiskUsageInfo } from "../util/disk-usage.js";

let diskSample: DiskUsageInfo | null = null;
let diskSampleError: unknown = null;

mock.module("../config/loader.js", () => ({
  getConfig: () => ({}),
}));

mock.module("../util/disk-usage.js", () => ({
  getDiskUsageInfo: () => {
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

const {
  DISK_PRESSURE_CLEAR_THRESHOLD_PERCENT,
  DISK_PRESSURE_OVERRIDE_CONFIRMATION,
  DISK_PRESSURE_THRESHOLD_PERCENT,
  DISK_PRESSURE_WARNING_CLEAR_THRESHOLD_PERCENT,
  DISK_PRESSURE_WARNING_THRESHOLD_PERCENT,
  __getDiskPressureGuardTimerForTests,
  __resetDiskPressureGuardForTests,
  acknowledgeDiskPressureLock,
  evaluateDiskPressureNow,
  getDiskPressureStatus,
  overrideDiskPressureLock,
  startDiskPressureGuard,
  stopDiskPressureGuard,
} = await import("../daemon/disk-pressure-guard.js");

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
  setDiskUsage(10);
});

afterEach(() => {
  __resetDiskPressureGuardForTests();
  diskSample = null;
  diskSampleError = null;
});

describe("disk pressure guard", () => {
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

  test("does not lock within the deadband until usage reaches the critical threshold", () => {
    setDiskUsage(DISK_PRESSURE_CLEAR_THRESHOLD_PERCENT + 2);

    const status = evaluateDiskPressureNow();

    expect(status.state).toBe("warning");
    expect(status.locked).toBe(false);
    expect(status.effectivelyLocked).toBe(false);
  });

  test("stays locked while usage stays within the hysteresis deadband", () => {
    setDiskUsage(DISK_PRESSURE_THRESHOLD_PERCENT + 1);
    const locked = evaluateDiskPressureNow();
    expect(locked.locked).toBe(true);
    const { lockId } = locked;

    // Below critical (95) but above clear (90): must hold, not flap.
    setDiskUsage(DISK_PRESSURE_CLEAR_THRESHOLD_PERCENT + 2);
    const status = evaluateDiskPressureNow();

    expect(status.state).toBe("critical");
    expect(status.locked).toBe(true);
    expect(status.effectivelyLocked).toBe(true);
    // Same lock id — the dip did not mint a fresh lock.
    expect(status.lockId).toBe(lockId);
  });

  test("preserves acknowledgement across a dip within the deadband", () => {
    setDiskUsage(DISK_PRESSURE_THRESHOLD_PERCENT + 1);
    evaluateDiskPressureNow();
    acknowledgeDiskPressureLock();

    setDiskUsage(DISK_PRESSURE_CLEAR_THRESHOLD_PERCENT + 2);
    const status = evaluateDiskPressureNow();

    expect(status.locked).toBe(true);
    expect(status.acknowledged).toBe(true);
  });

  test("clears the lock only once usage falls below the clear threshold", () => {
    setDiskUsage(DISK_PRESSURE_THRESHOLD_PERCENT + 1);
    evaluateDiskPressureNow();

    // Still within the deadband: locked.
    setDiskUsage(DISK_PRESSURE_CLEAR_THRESHOLD_PERCENT + 2);
    expect(evaluateDiskPressureNow().locked).toBe(true);

    // Below the clear threshold: released.
    setDiskUsage(DISK_PRESSURE_CLEAR_THRESHOLD_PERCENT - 2);
    const status = evaluateDiskPressureNow();

    expect(status.locked).toBe(false);
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

  test("does not enter warning until usage reaches the warning threshold", () => {
    // Below 80% and never previously in a pressure state.
    setDiskUsage(DISK_PRESSURE_WARNING_THRESHOLD_PERCENT - 2);

    const status = evaluateDiskPressureNow();

    expect(status.state).toBe("ok");
  });

  test("holds the warning state across a dip within the warning clear deadband", () => {
    setDiskUsage(DISK_PRESSURE_WARNING_THRESHOLD_PERCENT + 2);
    expect(evaluateDiskPressureNow().state).toBe("warning");

    // Below the 80% warning threshold but at/above the 77% clear threshold.
    setDiskUsage(DISK_PRESSURE_WARNING_CLEAR_THRESHOLD_PERCENT + 1);
    expect(evaluateDiskPressureNow().state).toBe("warning");
  });

  test("clears the warning state once usage falls below the warning clear threshold", () => {
    setDiskUsage(DISK_PRESSURE_WARNING_THRESHOLD_PERCENT + 2);
    expect(evaluateDiskPressureNow().state).toBe("warning");

    setDiskUsage(DISK_PRESSURE_WARNING_CLEAR_THRESHOLD_PERCENT - 1);
    expect(evaluateDiskPressureNow().state).toBe("ok");
  });

  test("steps a critical lock down into a held warning state", () => {
    setDiskUsage(DISK_PRESSURE_THRESHOLD_PERCENT + 1);
    expect(evaluateDiskPressureNow().state).toBe("critical");

    // Below the 90% critical clear but above the 80% warning threshold.
    setDiskUsage(DISK_PRESSURE_CLEAR_THRESHOLD_PERCENT - 2);
    const stepped = evaluateDiskPressureNow();
    expect(stepped.state).toBe("warning");
    expect(stepped.locked).toBe(false);

    // Now within the warning clear deadband — warning must hold, not flap to ok.
    setDiskUsage(DISK_PRESSURE_WARNING_CLEAR_THRESHOLD_PERCENT + 1);
    expect(evaluateDiskPressureNow().state).toBe("warning");
  });

  test("holds warning when a critical lock drops straight into the warning deadband", () => {
    setDiskUsage(DISK_PRESSURE_THRESHOLD_PERCENT + 1);
    expect(evaluateDiskPressureNow().state).toBe("critical");

    // A single large cleanup drops usage directly from critical to below the
    // 80% warning threshold but still at/above the 77% clear threshold. The
    // deadband must apply when stepping down out of critical too, so this holds
    // as warning rather than flapping to ok (which would reopen the flap window).
    setDiskUsage(DISK_PRESSURE_WARNING_CLEAR_THRESHOLD_PERCENT + 1);
    const stepped = evaluateDiskPressureNow();
    expect(stepped.state).toBe("warning");
    expect(stepped.locked).toBe(false);
  });

  test("clears straight to ok when a critical lock drops below the warning clear threshold", () => {
    setDiskUsage(DISK_PRESSURE_THRESHOLD_PERCENT + 1);
    expect(evaluateDiskPressureNow().state).toBe("critical");

    // A drop below even the warning-clear threshold is a genuine recovery.
    setDiskUsage(DISK_PRESSURE_WARNING_CLEAR_THRESHOLD_PERCENT - 1);
    expect(evaluateDiskPressureNow().state).toBe("ok");
  });
});
