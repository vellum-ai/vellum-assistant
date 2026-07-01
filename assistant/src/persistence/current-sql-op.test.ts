/**
 * Tests for the current-SQLite-op registry.
 *
 * - A marked op is snapshottable while in flight and gone once cleared.
 * - Nested ops obey LIFO and never leak, including when the wrapped `fn` throws.
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
  __resetCurrentSqlOpForTests,
  markSqlOpEnd,
  markSqlOpStart,
  snapshotCurrentSqlOp,
  withCurrentSqlOp,
} from "./current-sql-op.js";

afterEach(() => {
  __resetCurrentSqlOpForTests();
});

describe("snapshotCurrentSqlOp", () => {
  test("returns null when no op is marked", () => {
    expect(snapshotCurrentSqlOp()).toBeNull();
  });

  test("names the in-flight op with a plausible age, then null once cleared", () => {
    // GIVEN an op marked as started at t=1000
    markSqlOpStart("insertMessageCore");
    // WHEN snapshotted at t=1120
    const snap = snapshotCurrentSqlOp(performance.now() + 120);
    // THEN the op is named with a non-negative, plausible age
    expect(snap?.op).toBe("insertMessageCore");
    expect(snap?.ageMs).toBeGreaterThanOrEqual(0);
    expect(snap?.ageMs).toBeLessThan(10_000);
    // WHEN the op clears
    markSqlOpEnd();
    // THEN nothing is in flight
    expect(snapshotCurrentSqlOp()).toBeNull();
  });

  test("age never goes negative if the clock appears to move backwards", () => {
    markSqlOpStart("claimDueSchedules.recurring");
    const snap = snapshotCurrentSqlOp(-1);
    expect(snap?.ageMs).toBe(0);
  });
});

describe("nested ops", () => {
  test("clear in strict LIFO and never leak (A -> B -> clear B -> A -> null)", () => {
    // GIVEN outer op A
    markSqlOpStart("A");
    expect(snapshotCurrentSqlOp()?.op).toBe("A");
    // WHEN a nested op B is marked, it becomes the innermost in-flight op
    markSqlOpStart("B");
    expect(snapshotCurrentSqlOp()?.op).toBe("B");
    // WHEN B clears, A is once again the current op
    markSqlOpEnd();
    expect(snapshotCurrentSqlOp()?.op).toBe("A");
    // WHEN A clears, nothing remains
    markSqlOpEnd();
    expect(snapshotCurrentSqlOp()).toBeNull();
  });

  test("withCurrentSqlOp clears even when fn throws, leaving no stale op", () => {
    // GIVEN an outer op wrapping an inner op whose fn throws
    expect(() =>
      withCurrentSqlOp("outer", () => {
        withCurrentSqlOp("inner", () => {
          throw new Error("boom");
        });
      }),
    ).toThrow("boom");
    // THEN both marks are cleared — no leak past the throw
    expect(snapshotCurrentSqlOp()).toBeNull();
  });

  test("withCurrentSqlOp returns the wrapped value and marks only during fn", () => {
    const result = withCurrentSqlOp("completeScheduleRun.run", () => ({
      value: 42,
      opDuringFn: snapshotCurrentSqlOp()?.op ?? null,
    }));
    expect(result.value).toBe(42);
    expect(result.opDuringFn).toBe("completeScheduleRun.run");
    expect(snapshotCurrentSqlOp()).toBeNull();
  });
});
