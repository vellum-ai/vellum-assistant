/**
 * Tests for the event-loop block watchdog.
 *
 * - `evaluateTick` must derive the blocked duration as elapsed-beyond-interval
 *   and apply the threshold inclusively, clamping early/normal ticks to zero so
 *   a healthy loop never reports.
 * - `start`/`stop` must be idempotent and safe to call in any order so daemon
 *   startup and the two shutdown paths can call them unconditionally.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

/** Captured `log.warn` calls so the report path's fields can be asserted. */
const warnCalls: unknown[][] = [];

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get:
        (_t, prop) =>
        (...args: unknown[]) => {
          if (prop === "warn") warnCalls.push(args);
        },
    }),
}));

// The report path fires Sentry + telemetry; stub both so tests don't touch the
// network, DB, or consent cache.
mock.module("@sentry/node", () => ({
  withScope: (fn: (scope: unknown) => void) =>
    fn({ setLevel() {}, setTag() {}, setContext() {} }),
  captureMessage: () => {},
}));
mock.module("../telemetry/watchdog-events-store.js", () => ({
  recordWatchdogEvent: () => {},
}));

const {
  evaluateTick,
  reportBlock,
  startEventLoopWatchdog,
  stopEventLoopWatchdog,
} = await import("./event-loop-watchdog.js");
const { __resetCurrentSqlOpForTests, markSqlOpEnd, markSqlOpStart } =
  await import("../persistence/current-sql-op.js");

afterEach(() => {
  warnCalls.length = 0;
  __resetCurrentSqlOpForTests();
});

describe("evaluateTick", () => {
  const INTERVAL = 1_000;
  const THRESHOLD = 5_000;

  test("a healthy tick at the scheduled interval is not a block", () => {
    // GIVEN the timer fired right on schedule
    // WHEN the tick is evaluated
    const { blockedMs, exceeded } = evaluateTick(INTERVAL, INTERVAL, THRESHOLD);
    // THEN no block is observed
    expect(blockedMs).toBe(0);
    expect(exceeded).toBe(false);
  });

  test("an early tick clamps the blocked duration to zero", () => {
    // GIVEN the timer fired sooner than the interval (e.g. clock jitter)
    // WHEN the tick is evaluated
    const { blockedMs, exceeded } = evaluateTick(200, INTERVAL, THRESHOLD);
    // THEN the blocked duration never goes negative
    expect(blockedMs).toBe(0);
    expect(exceeded).toBe(false);
  });

  test("lateness under the threshold is measured but not reported", () => {
    // GIVEN the loop was blocked ~2s (below the 5s threshold)
    // WHEN the tick is evaluated
    const { blockedMs, exceeded } = evaluateTick(3_000, INTERVAL, THRESHOLD);
    // THEN the block is quantified but does not trip a report
    expect(blockedMs).toBe(2_000);
    expect(exceeded).toBe(false);
  });

  test("the threshold is inclusive", () => {
    // GIVEN the blocked duration lands exactly on the threshold
    // WHEN the tick is evaluated
    const { blockedMs, exceeded } = evaluateTick(
      INTERVAL + THRESHOLD,
      INTERVAL,
      THRESHOLD,
    );
    // THEN it counts as exceeded
    expect(blockedMs).toBe(THRESHOLD);
    expect(exceeded).toBe(true);
  });

  test("a multi-minute freeze reports the full blocked duration", () => {
    // GIVEN a ~123s freeze (the observed daemon-freeze magnitude) with a 1s tick
    // WHEN the first tick after unblock is evaluated
    const { blockedMs, exceeded } = evaluateTick(124_000, INTERVAL, THRESHOLD);
    // THEN the reported block excludes the one normal interval of wait
    expect(blockedMs).toBe(123_000);
    expect(exceeded).toBe(true);
  });
});

describe("reportBlock SQLite-op attribution", () => {
  test("names the op in flight when the block is reported", () => {
    // GIVEN a SQLite op executing on the loop thread
    markSqlOpStart("claimDueSchedules.recurring");
    try {
      // WHEN a block is reported while that op is still in flight
      reportBlock(6_000, 5_000);
    } finally {
      markSqlOpEnd();
    }
    // THEN the warn log attributes the freeze to that op with a plausible age
    const fields = warnCalls.at(-1)?.[0] as {
      blockedOp: string | null;
      blockedOpAgeMs: number | null;
      blockedMs: number;
    };
    expect(fields.blockedOp).toBe("claimDueSchedules.recurring");
    expect(fields.blockedOpAgeMs).toBeGreaterThanOrEqual(0);
    expect(fields.blockedMs).toBe(6_000);
  });

  test("reports blockedOp null when no SQLite op is in flight", () => {
    // GIVEN no op marked (block caused by non-SQLite work)
    // WHEN a block is reported
    reportBlock(7_000, 5_000);
    // THEN no op is fabricated
    const fields = warnCalls.at(-1)?.[0] as {
      blockedOp: string | null;
      blockedOpAgeMs: number | null;
    };
    expect(fields.blockedOp).toBeNull();
    expect(fields.blockedOpAgeMs).toBeNull();
  });
});

describe("start/stop lifecycle", () => {
  test("start and stop are idempotent and order-independent", () => {
    // GIVEN a fresh module
    // WHEN start/stop are called repeatedly and out of order
    // THEN none of the calls throw (daemon boot + both shutdown paths are safe)
    expect(() => stopEventLoopWatchdog()).not.toThrow();
    expect(() => startEventLoopWatchdog()).not.toThrow();
    expect(() => startEventLoopWatchdog()).not.toThrow();
    expect(() => stopEventLoopWatchdog()).not.toThrow();
    expect(() => stopEventLoopWatchdog()).not.toThrow();
  });
});
