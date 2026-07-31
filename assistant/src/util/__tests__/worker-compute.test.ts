import { afterEach, describe, expect, test } from "bun:test";

import {
  computeWorkerIntraOpThreads,
  ONNX_INTRA_OP_THREADS_ENV,
  WORKER_MAX_INTRA_OP_THREADS,
  WORKER_MIN_INTRA_OP_THREADS,
  workerComputeEnv,
} from "../worker-compute.js";

describe("computeWorkerIntraOpThreads", () => {
  test("targets a quarter of the available cores", () => {
    // 8 cores -> 2 threads, inside both clamps.
    expect(computeWorkerIntraOpThreads(8)).toBe(2);
  });

  test("clamps small machines up to the minimum", () => {
    // 2 cores -> 0 raw, which ONNX would read as "unbounded"; clamped up.
    expect(computeWorkerIntraOpThreads(2)).toBe(WORKER_MIN_INTRA_OP_THREADS);
  });

  test("clamps large machines down to the maximum", () => {
    // 64 cores -> 16 raw, clamped down.
    expect(computeWorkerIntraOpThreads(64)).toBe(WORKER_MAX_INTRA_OP_THREADS);
  });

  test("never returns a value ONNX would treat as unbounded", () => {
    for (const cores of [0, -1, -100, NaN, Infinity]) {
      expect(computeWorkerIntraOpThreads(cores)).toBeGreaterThanOrEqual(
        WORKER_MIN_INTRA_OP_THREADS,
      );
    }
  });

  test("fractional container quotas floor rather than round up", () => {
    // A 1.5-core cgroup quota must not hand ONNX more than it has.
    expect(computeWorkerIntraOpThreads(1.5)).toBe(WORKER_MIN_INTRA_OP_THREADS);
  });
});

describe("workerComputeEnv", () => {
  const saved = process.env[ONNX_INTRA_OP_THREADS_ENV];

  afterEach(() => {
    if (saved === undefined) {
      delete process.env[ONNX_INTRA_OP_THREADS_ENV];
    } else {
      process.env[ONNX_INTRA_OP_THREADS_ENV] = saved;
    }
  });

  test("computes a clamped thread cap", () => {
    delete process.env[ONNX_INTRA_OP_THREADS_ENV];
    const env = workerComputeEnv();
    const threads = Number(env[ONNX_INTRA_OP_THREADS_ENV]);
    expect(Number.isInteger(threads)).toBe(true);
    expect(threads).toBeGreaterThanOrEqual(WORKER_MIN_INTRA_OP_THREADS);
    expect(threads).toBeLessThanOrEqual(WORKER_MAX_INTRA_OP_THREADS);
  });

  test("keeps an operator-provided override", () => {
    process.env[ONNX_INTRA_OP_THREADS_ENV] = "7";
    expect(workerComputeEnv()[ONNX_INTRA_OP_THREADS_ENV]).toBe("7");
  });
});
