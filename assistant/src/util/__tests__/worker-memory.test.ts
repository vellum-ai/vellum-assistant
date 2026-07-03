import { describe, expect, test } from "bun:test";

import {
  computeWorkerForceRamSizeBytes,
  WORKER_FORCE_RAM_MAX_BYTES,
  WORKER_FORCE_RAM_MIN_BYTES,
  workerMemoryEnv,
} from "../worker-memory.js";

const GIB = 1024 * 1024 * 1024;

describe("computeWorkerForceRamSizeBytes", () => {
  test("targets a quarter of the container limit", () => {
    // 5 GiB (medium machine) → 1.25 GiB, inside both clamps.
    expect(computeWorkerForceRamSizeBytes(5 * GIB)).toBe(1.25 * GIB);
  });

  test("clamps small containers up to the minimum", () => {
    // 1 GiB → 256 MiB raw, clamped up.
    expect(computeWorkerForceRamSizeBytes(1 * GIB)).toBe(
      WORKER_FORCE_RAM_MIN_BYTES,
    );
  });

  test("clamps large containers down to the maximum", () => {
    // 16 GiB (extra_large machine) → 4 GiB raw, clamped down.
    expect(computeWorkerForceRamSizeBytes(16 * GIB)).toBe(
      WORKER_FORCE_RAM_MAX_BYTES,
    );
  });

  test("falls back to host total memory when no container limit applies", () => {
    const result = computeWorkerForceRamSizeBytes(null);
    expect(result).toBeGreaterThanOrEqual(WORKER_FORCE_RAM_MIN_BYTES);
    expect(result).toBeLessThanOrEqual(WORKER_FORCE_RAM_MAX_BYTES);
  });
});

describe("workerMemoryEnv", () => {
  test("adds BUN_JSC_forceRAMSize on top of the parent environment", () => {
    const env = workerMemoryEnv({ PATH: "/usr/bin" }, 5 * GIB);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.BUN_JSC_forceRAMSize).toBe(String(1.25 * GIB));
  });

  test("keeps an operator-provided BUN_JSC_forceRAMSize", () => {
    const env = workerMemoryEnv({ BUN_JSC_forceRAMSize: "12345" }, 5 * GIB);
    expect(env.BUN_JSC_forceRAMSize).toBe("12345");
  });
});
