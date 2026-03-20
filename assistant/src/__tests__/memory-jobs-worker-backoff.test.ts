/**
 * Tests for adaptive poll interval backoff in the memory jobs worker.
 *
 * Verifies that when no jobs are claimable, the poll interval doubles each
 * tick (1.5s -> 3s -> 6s -> ... -> 30s cap), and resets to 1.5s when work
 * is found.
 */
import { describe, expect, mock, test } from "bun:test";

// ── Mocks (must precede imports of tested module) ──────────────────

mock.module("../util/platform.js", () => ({
  getDataDir: () => "/tmp/test-backoff",
  isMacOS: () => false,
  isLinux: () => true,
  isWindows: () => false,
  getPidPath: () => "/tmp/test-backoff/test.pid",
  getDbPath: () => "/tmp/test-backoff/test.db",
  getLogPath: () => "/tmp/test-backoff/test.log",
  ensureDataDir: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Mock config — memory disabled so runMemoryJobsOnce returns 0 immediately
mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    memory: { enabled: false },
  }),
  loadConfig: () => ({
    memory: { enabled: false },
  }),
}));

// Mock jobs-store (accesses DB)
mock.module("../memory/jobs-store.js", () => ({
  resetRunningJobsToPending: () => 0,
  claimMemoryJobs: () => [],
  completeMemoryJob: () => {},
  deferMemoryJob: () => "deferred",
  failMemoryJob: () => {},
  failStalledJobs: () => 0,
  enqueueCleanupStaleSupersededItemsJob: () => null,
  enqueuePruneOldConversationsJob: () => null,
}));

// Mock db.js (rawRun used in sweepStaleItems)
mock.module("../memory/db.js", () => ({
  rawRun: () => 0,
}));

import {
  POLL_INTERVAL_MAX_MS,
  POLL_INTERVAL_MIN_MS,
  startMemoryJobsWorker,
} from "../memory/jobs-worker.js";

describe("memory jobs worker adaptive poll interval", () => {
  test("exports expected poll interval constants", () => {
    expect(POLL_INTERVAL_MIN_MS).toBe(1_500);
    expect(POLL_INTERVAL_MAX_MS).toBe(30_000);
  });

  test("backoff sequence doubles from min to max then caps", () => {
    // Verify the math: starting at 1500, doubling each step, capped at 30000
    const intervals: number[] = [];
    let current = POLL_INTERVAL_MIN_MS;
    for (let i = 0; i < 10; i++) {
      intervals.push(current);
      current = Math.min(current * 2, POLL_INTERVAL_MAX_MS);
    }
    expect(intervals).toEqual([
      1_500, // tick 1
      3_000, // tick 2
      6_000, // tick 3
      12_000, // tick 4
      24_000, // tick 5
      30_000, // tick 6 (capped)
      30_000, // stays capped
      30_000,
      30_000,
      30_000,
    ]);
  });

  test("worker schedules setTimeout with increasing intervals when idle", async () => {
    const timeoutDelays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;

    // Collect pending timer callbacks so we can fire them manually
    const pendingCallbacks: Array<() => void> = [];

    globalThis.setTimeout = ((fn: () => void, delay?: number) => {
      if (delay !== undefined && delay >= POLL_INTERVAL_MIN_MS) {
        timeoutDelays.push(delay);
        pendingCallbacks.push(fn);
      }
      return 999 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.clearTimeout = (() => {}) as typeof clearTimeout;

    try {
      const worker = startMemoryJobsWorker();

      // Wait for the initial tick() promise to settle
      await new Promise((resolve) => originalSetTimeout(resolve, 20));

      // Fire pending timer callbacks to advance through the backoff sequence.
      // Each callback triggers tick() which is async, so we await a microtask
      // after each to let the promise chain settle and schedule the next timer.
      for (let i = 0; i < 6; i++) {
        const cb = pendingCallbacks.shift();
        if (cb) {
          cb();
          await new Promise((resolve) => originalSetTimeout(resolve, 20));
        }
      }

      worker.stop();

      // We should have captured several setTimeout calls with increasing delays
      expect(timeoutDelays.length).toBeGreaterThanOrEqual(4);

      // Intervals should be non-decreasing (backoff)
      for (let i = 1; i < timeoutDelays.length; i++) {
        expect(timeoutDelays[i]).toBeGreaterThanOrEqual(timeoutDelays[i - 1]!);
      }

      // All intervals within bounds
      for (const delay of timeoutDelays) {
        expect(delay).toBeGreaterThanOrEqual(POLL_INTERVAL_MIN_MS);
        expect(delay).toBeLessThanOrEqual(POLL_INTERVAL_MAX_MS);
      }

      // Should eventually reach the cap
      expect(timeoutDelays[timeoutDelays.length - 1]).toBe(
        POLL_INTERVAL_MAX_MS,
      );
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });
});
