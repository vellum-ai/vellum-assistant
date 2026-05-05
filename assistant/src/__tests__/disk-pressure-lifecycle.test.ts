import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { DiskUsageInfo } from "../util/disk-usage.js";

let diskSample: DiskUsageInfo | null = null;
let diskSampleError: unknown = null;
let diskSampleCalls = 0;
const warnCalls: unknown[] = [];

mock.module("../util/disk-usage.js", () => ({
  __resetDiskUsageCacheForTests: () => {},
  getDiskUsageInfo: () => {
    diskSampleCalls += 1;
    if (diskSampleError) throw diskSampleError;
    return diskSample;
  },
  parseK8sMemoryBytes: (value: string) => {
    const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(Mi|Gi|M|G)?$/);
    if (!match) return null;
    const amount = Number(match[1]);
    const unit = match[2] ?? "";
    const multipliers: Record<string, number> = {
      "": 1,
      M: 1e6,
      G: 1e9,
      Mi: 1024 ** 2,
      Gi: 1024 ** 3,
    };
    return Math.round(amount * multipliers[unit]);
  },
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

const { _setOverridesForTesting } =
  await import("../config/assistant-feature-flags.js");
const {
  __getDiskPressureGuardTimerForTests,
  __resetDiskPressureGuardForTests,
  getDiskPressureStatus,
} = await import("../daemon/disk-pressure-guard.js");
const {
  startDiskPressureGuardForLifecycle,
  stopDiskPressureGuardForLifecycle,
} = await import("../daemon/lifecycle.js");

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

beforeEach(() => {
  __resetDiskPressureGuardForTests();
  setFeatureFlag(true);
  setDiskUsage(10);
  diskSampleCalls = 0;
  warnCalls.length = 0;
});

afterEach(() => {
  stopDiskPressureGuardForLifecycle();
  __resetDiskPressureGuardForTests();
  _setOverridesForTesting({});
  diskSample = null;
  diskSampleError = null;
  diskSampleCalls = 0;
  warnCalls.length = 0;
});

describe("disk pressure guard lifecycle", () => {
  test("starts once and immediately evaluates when enabled", () => {
    startDiskPressureGuardForLifecycle();
    const firstTimer = __getDiskPressureGuardTimerForTests();

    expect(firstTimer).toBeTruthy();
    expect(diskSampleCalls).toBe(1);
    expect(getDiskPressureStatus().state).toBe("ok");

    startDiskPressureGuardForLifecycle();

    expect(__getDiskPressureGuardTimerForTests()).toBe(firstTimer);
    expect(diskSampleCalls).toBe(2);
  });

  test("stays inert when the feature flag is disabled", () => {
    setFeatureFlag(false);

    startDiskPressureGuardForLifecycle();

    expect(__getDiskPressureGuardTimerForTests()).toBeNull();
    expect(diskSampleCalls).toBe(0);
    expect(getDiskPressureStatus().state).toBe("disabled");
  });

  test("logs sample failures and leaves startup unlocked", () => {
    diskSampleError = new Error("sample failed");

    expect(() => startDiskPressureGuardForLifecycle()).not.toThrow();

    const status = getDiskPressureStatus();
    expect(status.state).toBe("unknown");
    expect(status.locked).toBe(false);
    expect(status.effectivelyLocked).toBe(false);
    expect(status.error).toBe("sample failed");
    expect(__getDiskPressureGuardTimerForTests()).toBeTruthy();
    expect(warnCalls.length).toBe(1);
  });

  test("stop clears the lifecycle timer", () => {
    startDiskPressureGuardForLifecycle();
    expect(__getDiskPressureGuardTimerForTests()).toBeTruthy();

    stopDiskPressureGuardForLifecycle();

    expect(__getDiskPressureGuardTimerForTests()).toBeNull();
  });
});
