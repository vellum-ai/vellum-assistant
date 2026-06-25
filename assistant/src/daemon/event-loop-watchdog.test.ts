/**
 * Tests for the event-loop block watchdog.
 *
 * - `evaluateTick` must derive the blocked duration as elapsed-beyond-interval
 *   and apply the threshold inclusively, clamping early/normal ticks to zero so
 *   a healthy loop never reports.
 * - `start`/`stop` must be idempotent and safe to call in any order so daemon
 *   startup and the two shutdown paths can call them unconditionally.
 */
import { describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

const { evaluateTick, startEventLoopWatchdog, stopEventLoopWatchdog } =
  await import("./event-loop-watchdog.js");

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
