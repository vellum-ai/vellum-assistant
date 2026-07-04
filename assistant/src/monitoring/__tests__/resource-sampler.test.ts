/**
 * Tests for the sampler's pure delta computation. The sampling functions
 * themselves read fixed /sys and /proc paths, so only the diff layer is
 * exercised here.
 */

import { describe, expect, test } from "bun:test";

import {
  computeSampleDeltas,
  type ResourceSample,
} from "../resource-sampler.js";

function makeSample(overrides: Partial<ResourceSample>): ResourceSample {
  return {
    ts: 0,
    memory: null,
    memoryStat: null,
    reclaim: null,
    events: null,
    deltas: null,
    disk: null,
    ...overrides,
  };
}

describe("computeSampleDeltas", () => {
  test("diffs events and reclaim counters per key", () => {
    const prev = makeSample({
      ts: 1000,
      events: { low: 0, high: 5, max: 100, oom: 0, oomKill: 0 },
      reclaim: {
        pgscanDirect: 1_000_000,
        pgstealDirect: 900_000,
        workingsetRefaultFile: 500,
      },
    });
    const current = makeSample({
      ts: 1250,
      events: { low: 0, high: 7, max: 150, oom: 1, oomKill: 0 },
      reclaim: {
        pgscanDirect: 1_400_000,
        pgstealDirect: 1_200_000,
        workingsetRefaultFile: 800,
      },
    });

    expect(computeSampleDeltas(prev, current)).toEqual({
      events: { low: 0, high: 2, max: 50, oom: 1, oomKill: 0 },
      reclaim: {
        pgscanDirect: 400_000,
        pgstealDirect: 300_000,
        workingsetRefaultFile: 300,
      },
    });
  });

  test("is null-wise when a side or a counter is unavailable", () => {
    const prev = makeSample({
      reclaim: {
        pgscanDirect: 100,
        pgstealDirect: null,
        workingsetRefaultFile: 10,
      },
    });
    const current = makeSample({
      events: { low: 0, high: 0, max: 0, oom: 0, oomKill: 0 },
      reclaim: {
        pgscanDirect: 150,
        pgstealDirect: 90,
        workingsetRefaultFile: 10,
      },
    });

    const deltas = computeSampleDeltas(prev, current);
    // prev.events is null, so no event deltas.
    expect(deltas.events).toBeNull();
    expect(deltas.reclaim).toEqual({
      pgscanDirect: 50,
      pgstealDirect: null,
      workingsetRefaultFile: 0,
    });
  });
});
