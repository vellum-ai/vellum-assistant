import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { ResourcePressureStatusChangedEventSchema } from "../api/events/resource-pressure-status-changed.js";
import type { ResourcePressureStatus } from "../daemon/resource-pressure-guard.js";

const broadcasts: unknown[] = [];

mock.module("../runtime/assistant-event-hub.js", () => ({
  AssistantEventHub: class {},
  broadcastMessage: (message: unknown) => {
    broadcasts.push(message);
  },
  capabilityForMessageType: () => undefined,
  assistantEventHub: {
    publish: async () => {},
  },
}));

// Default readers report no container accounting, so tests that exercise the
// default samplers see both signals unavailable. Individual tests override
// the mutable values to exercise other default-sampler paths.
let mockedCpuCores = 0;
let mockedCachedCpuPercentOrNull: number | null = null;

mock.module("../util/container-cpu-sampler.js", () => ({
  getCachedContainerCpuPercent: () => mockedCachedCpuPercentOrNull ?? 0,
  getCachedContainerCpuPercentOrNull: () => mockedCachedCpuPercentOrNull,
  getAverageContainerCpuPercentOrNull: (_windowMs: number) =>
    mockedCachedCpuPercentOrNull,
}));

mock.module("../util/cgroup-cpu.js", () => ({
  getContainerCpuCores: () => mockedCpuCores,
}));

let mockedMemoryLimitBytes: number | null = null;
let mockedMemoryUsageBytes: number | null = null;
let mockedMemoryStat: {
  inactiveFileBytes: number | null;
  slabReclaimableBytes: number | null;
} | null = null;

mock.module("../util/cgroup-memory.js", () => ({
  getContainerMemoryLimitBytes: () => mockedMemoryLimitBytes,
  getContainerMemoryUsageBytes: () => mockedMemoryUsageBytes,
  getContainerMemoryStat: () => mockedMemoryStat,
}));

const {
  RESOURCE_PRESSURE_CLEAR_CONSECUTIVE_SAMPLES,
  RESOURCE_PRESSURE_ENTER_SAMPLES,
  RESOURCE_PRESSURE_WINDOW_SAMPLES,
  __getResourcePressureGuardTimerForTests,
  __resetResourcePressureGuardForTests,
  evaluateResourcePressureNow,
  getResourcePressureStatus,
  startResourcePressureGuard,
  stopResourcePressureGuard,
} = await import("../daemon/resource-pressure-guard.js");

function evaluateCpu(percent: number): ResourcePressureStatus {
  return evaluateResourcePressureNow({
    sampleCpuPercent: () => percent,
    sampleMemory: () => null,
  });
}

function driveCpu(count: number, percent: number): ResourcePressureStatus {
  let status: ResourcePressureStatus | null = null;
  for (let i = 0; i < count; i += 1) {
    status = evaluateCpu(percent);
  }
  return status!;
}

function driveMemory(
  count: number,
  sample: { usageBytes: number; limitBytes: number; reclaimableBytes: number },
): ResourcePressureStatus {
  let status: ResourcePressureStatus | null = null;
  for (let i = 0; i < count; i += 1) {
    status = evaluateResourcePressureNow({
      sampleCpuPercent: () => null,
      sampleMemory: () => sample,
    });
  }
  return status!;
}

function enterCpuElevated(): ResourcePressureStatus {
  const idleSamples =
    RESOURCE_PRESSURE_WINDOW_SAMPLES - RESOURCE_PRESSURE_ENTER_SAMPLES;
  driveCpu(idleSamples, 10);
  const status = driveCpu(RESOURCE_PRESSURE_ENTER_SAMPLES, 95);
  expect(status.state).toBe("elevated");
  return status;
}

const originalIsPlatform = process.env.IS_PLATFORM;

beforeEach(() => {
  __resetResourcePressureGuardForTests();
  broadcasts.length = 0;
  mockedCpuCores = 0;
  mockedCachedCpuPercentOrNull = null;
  mockedMemoryLimitBytes = null;
  mockedMemoryUsageBytes = null;
  mockedMemoryStat = null;
  process.env.IS_PLATFORM = "true";
});

afterEach(() => {
  __resetResourcePressureGuardForTests();
  broadcasts.length = 0;
  if (originalIsPlatform === undefined) {
    delete process.env.IS_PLATFORM;
  } else {
    process.env.IS_PLATFORM = originalIsPlatform;
  }
});

describe("resource pressure guard", () => {
  test("stays disabled off-platform: no timer, no samples, no broadcasts", () => {
    delete process.env.IS_PLATFORM;

    const started = startResourcePressureGuard();

    expect(started.enabled).toBe(false);
    expect(started.state).toBe("disabled");
    expect(__getResourcePressureGuardTimerForTests()).toBeNull();

    const evaluated = evaluateCpu(99);
    expect(evaluated.enabled).toBe(false);
    expect(evaluated.state).toBe("disabled");

    const status = getResourcePressureStatus();
    expect(status.enabled).toBe(false);
    expect(status.state).toBe("disabled");

    expect(broadcasts.length).toBe(0);
  });

  test("17 of 20 samples over the CPU threshold stays ok", () => {
    driveCpu(3, 10);
    const status = driveCpu(17, 95);

    expect(status.state).toBe("ok");
    expect(status.cpuElevated).toBe(false);
    expect(status.cpuPercent).toBe(95);
  });

  test("18 of 20 samples over the CPU threshold enters elevated", () => {
    const status = enterCpuElevated();

    expect(status.cpuElevated).toBe(true);
    expect(status.memoryElevated).toBe(false);
    expect(status.enabled).toBe(true);
  });

  test("does not enter elevated before the window is full", () => {
    let status = evaluateCpu(95);
    for (let i = 1; i < RESOURCE_PRESSURE_WINDOW_SAMPLES - 1; i += 1) {
      status = evaluateCpu(95);
      expect(status.state).toBe("ok");
    }

    status = evaluateCpu(95);
    expect(status.state).toBe("elevated");
  });

  test("a 10-sample spike inside an otherwise idle window never enters elevated", () => {
    const statuses: ResourcePressureStatus[] = [];
    for (let i = 0; i < 5; i += 1) {
      statuses.push(evaluateCpu(10));
    }
    for (let i = 0; i < 10; i += 1) {
      statuses.push(evaluateCpu(95));
    }
    for (let i = 0; i < 10; i += 1) {
      statuses.push(evaluateCpu(10));
    }

    for (const status of statuses) {
      expect(status.state).toBe("ok");
      expect(status.cpuElevated).toBe(false);
    }
  });

  test("holds elevated between the clear and enter thresholds, clears after 10 consecutive below clear", () => {
    enterCpuElevated();

    // 75% is below the 85% enter threshold but above the 70% clear threshold:
    // hysteresis holds the elevated state.
    for (let i = 0; i < 15; i += 1) {
      expect(evaluateCpu(75).state).toBe("elevated");
    }

    // Below the clear threshold, but not yet for long enough.
    let status = driveCpu(RESOURCE_PRESSURE_CLEAR_CONSECUTIVE_SAMPLES - 1, 60);
    expect(status.state).toBe("elevated");

    // The 10th consecutive sample below the clear threshold clears it.
    status = evaluateCpu(60);
    expect(status.state).toBe("ok");
    expect(status.cpuElevated).toBe(false);
  });

  test("a dip above the clear threshold resets the consecutive clear count", () => {
    enterCpuElevated();

    for (
      let i = 0;
      i < RESOURCE_PRESSURE_CLEAR_CONSECUTIVE_SAMPLES - 1;
      i += 1
    ) {
      expect(evaluateCpu(60).state).toBe("elevated");
    }
    // Back above clear: the run restarts.
    expect(evaluateCpu(75).state).toBe("elevated");
    for (
      let i = 0;
      i < RESOURCE_PRESSURE_CLEAR_CONSECUTIVE_SAMPLES - 1;
      i += 1
    ) {
      expect(evaluateCpu(60).state).toBe("elevated");
    }
    expect(evaluateCpu(60).state).toBe("ok");
  });

  test("reclaimable file cache is subtracted from the memory working set", () => {
    // Usage at 95% of the limit, but 20% of the limit is reclaimable page
    // cache: the working set is 75%, under the 90% threshold.
    const status = driveMemory(RESOURCE_PRESSURE_WINDOW_SAMPLES + 5, {
      usageBytes: 950,
      limitBytes: 1000,
      reclaimableBytes: 200,
    });

    expect(status.state).toBe("ok");
    expect(status.memoryElevated).toBe(false);
    expect(status.memoryPercent).toBe(75);
  });

  test("unreclaimable memory over the threshold enters elevated", () => {
    const status = driveMemory(RESOURCE_PRESSURE_WINDOW_SAMPLES, {
      usageBytes: 950,
      limitBytes: 1000,
      reclaimableBytes: 0,
    });

    expect(status.state).toBe("elevated");
    expect(status.memoryElevated).toBe(true);
    expect(status.cpuElevated).toBe(false);
    expect(status.memoryPercent).toBe(95);
  });

  test("broadcasts exactly on ok to elevated and elevated to ok transitions", () => {
    enterCpuElevated();
    expect(broadcasts.length).toBe(1);

    // More elevated samples do not re-broadcast.
    driveCpu(5, 95);
    expect(broadcasts.length).toBe(1);

    driveCpu(RESOURCE_PRESSURE_CLEAR_CONSECUTIVE_SAMPLES, 60);
    expect(broadcasts.length).toBe(2);

    const elevatedEvent = ResourcePressureStatusChangedEventSchema.parse(
      broadcasts[0],
    );
    expect(elevatedEvent.status.state).toBe("elevated");
    expect(elevatedEvent.status.cpuElevated).toBe(true);

    const clearedEvent = ResourcePressureStatusChangedEventSchema.parse(
      broadcasts[1],
    );
    expect(clearedEvent.status.state).toBe("ok");
    expect(clearedEvent.status.cpuElevated).toBe(false);

    // Further ok samples stay silent.
    driveCpu(5, 10);
    expect(broadcasts.length).toBe(2);
  });

  test("missing memory limit and zero CPU cores yield unknown, never elevated", () => {
    let status: ResourcePressureStatus | null = null;
    for (let i = 0; i < RESOURCE_PRESSURE_WINDOW_SAMPLES + 5; i += 1) {
      // No injected samplers: the mocked default readers report zero cores
      // and a null memory limit.
      status = evaluateResourcePressureNow();
      expect(status.state).toBe("unknown");
      expect(status.cpuElevated).toBe(false);
      expect(status.memoryElevated).toBe(false);
    }

    expect(status!.enabled).toBe(true);
    expect(status!.cpuPercent).toBeNull();
    expect(status!.memoryPercent).toBeNull();
    expect(status!.error).toBeTruthy();
    expect(status!.lastCheckedAt).toBeTruthy();
  });

  test("the default memory sampler is unavailable without a reclaimable breakdown", () => {
    // Usage and limit are readable but memory.stat is not (cgroups v1, or
    // missing v2 counters): the working set is unknowable, so the signal
    // must read unavailable instead of assuming zero reclaimable cache.
    mockedMemoryLimitBytes = 1000;
    mockedMemoryUsageBytes = 950;
    mockedMemoryStat = null;

    let status = evaluateResourcePressureNow();
    expect(status.state).toBe("unknown");
    expect(status.memoryPercent).toBeNull();

    // An inactive_file counter alone is not enough to be missing: without
    // it the readily-reclaimable split is unknowable even when slab counters
    // parse.
    mockedMemoryStat = { inactiveFileBytes: null, slabReclaimableBytes: 100 };
    status = evaluateResourcePressureNow();
    expect(status.memoryPercent).toBeNull();

    // Only inactive file pages and reclaimable slab leave the working set;
    // active file pages remain counted.
    mockedMemoryStat = { inactiveFileBytes: 300, slabReclaimableBytes: 100 };
    status = evaluateResourcePressureNow();
    expect(status.state).toBe("ok");
    expect(status.memoryPercent).toBe(55);
  });

  test("the default CPU sampler is unavailable until the rolling sampler warms up", () => {
    // Cores are known but the rolling sampler has not computed a delta yet:
    // the default sampler must report the signal unavailable rather than
    // feed a genuine-looking 0% into the window.
    mockedCpuCores = 4;

    let status = evaluateResourcePressureNow();
    expect(status.state).toBe("unknown");
    expect(status.cpuPercent).toBeNull();
    expect(status.cpuElevated).toBe(false);

    // The first computed delta makes the signal available.
    mockedCachedCpuPercentOrNull = 42;
    status = evaluateResourcePressureNow();
    expect(status.state).toBe("ok");
    expect(status.cpuPercent).toBe(42);
  });

  test("an unavailable signal resets its window and drops its elevated flag", () => {
    enterCpuElevated();

    // CPU sample becomes unavailable: the signal cannot hold elevated.
    const status = evaluateResourcePressureNow({
      sampleCpuPercent: () => null,
      sampleMemory: () => ({
        usageBytes: 100,
        limitBytes: 1000,
        reclaimableBytes: 0,
      }),
    });

    expect(status.state).toBe("ok");
    expect(status.cpuElevated).toBe(false);
    expect(status.cpuPercent).toBeNull();
    expect(status.memoryPercent).toBe(10);
    // A null sample is a legitimately unavailable signal, not an error.
    expect(status.error).toBeNull();
  });

  test("a throwing sampler surfaces its error while the healthy signal still evaluates", () => {
    const memorySample = {
      usageBytes: 100,
      limitBytes: 1000,
      reclaimableBytes: 0,
    };
    const healthy = {
      sampleCpuPercent: () => 10,
      sampleMemory: () => memorySample,
    };
    const cpuThrows = {
      sampleCpuPercent: () => {
        throw new Error("cpu reader exploded");
      },
      sampleMemory: () => memorySample,
    };

    evaluateResourcePressureNow(healthy);
    expect(broadcasts.length).toBe(0);

    let status = evaluateResourcePressureNow(cpuThrows);
    expect(status.state).toBe("ok");
    expect(status.error).toContain("cpu reader exploded");
    expect(status.cpuPercent).toBeNull();
    expect(status.memoryPercent).toBe(10);
    expect(broadcasts.length).toBe(1);

    const failedEvent = ResourcePressureStatusChangedEventSchema.parse(
      broadcasts[0],
    );
    expect(failedEvent.status.error).toContain("cpu reader exploded");

    // Repeated failures do not re-broadcast.
    status = evaluateResourcePressureNow(cpuThrows);
    expect(status.error).toContain("cpu reader exploded");
    expect(broadcasts.length).toBe(1);

    // Recovery clears the error and broadcasts exactly once more.
    status = evaluateResourcePressureNow(healthy);
    expect(status.error).toBeNull();
    expect(broadcasts.length).toBe(2);
  });

  test("timer start and stop are idempotent on platform", () => {
    expect(__getResourcePressureGuardTimerForTests()).toBeNull();

    startResourcePressureGuard();
    const firstTimer = __getResourcePressureGuardTimerForTests();
    expect(firstTimer).toBeTruthy();

    startResourcePressureGuard();
    expect(__getResourcePressureGuardTimerForTests()).toBe(firstTimer);

    stopResourcePressureGuard();
    expect(__getResourcePressureGuardTimerForTests()).toBeNull();

    stopResourcePressureGuard();
    expect(__getResourcePressureGuardTimerForTests()).toBeNull();
  });
});
