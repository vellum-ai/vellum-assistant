import { afterEach, describe, expect, test } from "bun:test";

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

  test("gives no hint when no container limit applies", () => {
    expect(computeWorkerForceRamSizeBytes(null)).toBeNull();
  });
});

describe("workerMemoryEnv", () => {
  const savedEnv = {
    BUN_JSC_forceRAMSize: process.env.BUN_JSC_forceRAMSize,
    VELLUM_MEMORY_LIMIT: process.env.VELLUM_MEMORY_LIMIT,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  test("adds the container-derived BUN_JSC_forceRAMSize on top of the parent environment", () => {
    // VELLUM_MEMORY_LIMIT takes precedence over cgroup files: 4 GiB → 1 GiB.
    delete process.env.BUN_JSC_forceRAMSize;
    process.env.VELLUM_MEMORY_LIMIT = "4Gi";
    const env = workerMemoryEnv();
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.BUN_JSC_forceRAMSize).toBe(String(GIB));
  });

  test("keeps an operator-provided BUN_JSC_forceRAMSize", () => {
    process.env.BUN_JSC_forceRAMSize = "12345";
    process.env.VELLUM_MEMORY_LIMIT = "4Gi";
    expect(workerMemoryEnv().BUN_JSC_forceRAMSize).toBe("12345");
  });
});
