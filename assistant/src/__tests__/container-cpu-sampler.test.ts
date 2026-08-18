import { describe, expect, test } from "bun:test";

import {
  computeCpuPercent,
  getCachedContainerCpuPercent,
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
