import { describe, expect, test } from "bun:test";

import {
  __resetContainerCpuSamplerForTests,
  __runContainerCpuSamplerTickForTests,
  computeCpuPercent,
  getAverageContainerCpuPercentOrNull,
  getCachedContainerCpuPercent,
  getCachedContainerCpuPercentOrNull,
} from "../util/container-cpu-sampler.js";

describe("computeCpuPercent", () => {
  test("computes percent of the full allocation from a CPU-time delta", () => {
    // 2.5s of CPU over a 5s window on 1 core is 50% of the allocation.
    expect(computeCpuPercent(2_500_000, 5_000, 1)).toBe(50);
    // The same delta on 2 cores is half the utilization.
    expect(computeCpuPercent(2_500_000, 5_000, 2)).toBe(25);
    // Fully saturating 4 cores for the whole window is 100%.
    expect(computeCpuPercent(20_000_000, 5_000, 4)).toBe(100);
  });

  test("rounds to 2 decimal places", () => {
    expect(computeCpuPercent(123_456, 5_000, 2)).toBe(1.23);
    expect(computeCpuPercent(123_999, 5_000, 2)).toBe(1.24);
    expect(computeCpuPercent(0, 5_000, 1)).toBe(0);
  });

  test("yields a non-finite result for zero cores, which callers must guard", () => {
    expect(Number.isFinite(computeCpuPercent(1_000_000, 5_000, 0))).toBe(false);
    expect(Number.isFinite(computeCpuPercent(0, 5_000, 0))).toBe(false);
  });
});

describe("getCachedContainerCpuPercent", () => {
  test("returns a finite number", () => {
    expect(Number.isFinite(getCachedContainerCpuPercent())).toBe(true);
  });
});

describe("getCachedContainerCpuPercentOrNull", () => {
  test("returns null until the sampler computes its first delta", () => {
    __resetContainerCpuSamplerForTests();

    expect(getCachedContainerCpuPercentOrNull()).toBeNull();
    // The plain accessor keeps its 0 placeholder for /v1/health.
    expect(getCachedContainerCpuPercent()).toBe(0);

    // Drive one sampler tick a full interval ahead of the reset baseline so
    // it computes a real delta from process.cpuUsage().
    __runContainerCpuSamplerTickForTests(Date.now() + 5_000);

    const sampled = getCachedContainerCpuPercentOrNull();
    expect(sampled).not.toBeNull();
    expect(Number.isFinite(sampled!)).toBe(true);
    expect(sampled).toBe(getCachedContainerCpuPercent());
  });
});

describe("getAverageContainerCpuPercentOrNull", () => {
  test("returns null until a tick lands inside the window", () => {
    __resetContainerCpuSamplerForTests();

    expect(getAverageContainerCpuPercentOrNull(60_000)).toBeNull();
  });

  test("averages the ticks recorded within the trailing window", () => {
    __resetContainerCpuSamplerForTests();

    // A single recorded tick makes the average equal the last cached value.
    __runContainerCpuSamplerTickForTests(Date.now() + 5_000);
    const single = getAverageContainerCpuPercentOrNull(60_000);
    expect(single).not.toBeNull();
    expect(single).toBe(getCachedContainerCpuPercentOrNull());

    // More ticks keep the average finite and within the recorded range; the
    // exact value depends on real process CPU deltas, so only the invariant
    // is asserted.
    __runContainerCpuSamplerTickForTests(Date.now() + 10_000);
    __runContainerCpuSamplerTickForTests(Date.now() + 15_000);
    const averaged = getAverageContainerCpuPercentOrNull(60_000);
    expect(averaged).not.toBeNull();
    expect(Number.isFinite(averaged!)).toBe(true);
    expect(averaged!).toBeGreaterThanOrEqual(0);
  });
});
