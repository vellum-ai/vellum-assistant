import { beforeEach, describe, expect, test } from "bun:test";

import { getMemorySqlite } from "../../../../persistence/db-connection.js";
import { initializeDb } from "../../../../persistence/db-init.js";
import {
  getRetrospectiveDailyCount,
  isDailyRetrospectiveBudgetExhausted,
  recordDailyRetrospectiveRun,
  utcDayKey,
} from "../memory-retrospective-daily-count.js";

await initializeDb();

const DAY1 = Date.parse("2026-07-23T12:00:00Z");
const DAY1_LATER = Date.parse("2026-07-23T23:30:00Z"); // same UTC day as DAY1
const DAY2 = Date.parse("2026-07-24T00:30:00Z"); // next UTC day

function resetTable(): void {
  getMemorySqlite()!.exec(`DELETE FROM memory_retrospective_daily_count`);
}

describe("utcDayKey", () => {
  test("keys by UTC calendar day, ignoring the wall-clock time", () => {
    expect(utcDayKey(DAY1)).toBe("2026-07-23");
    expect(utcDayKey(DAY1_LATER)).toBe("2026-07-23");
    expect(utcDayKey(DAY2)).toBe("2026-07-24");
  });
});

describe("isDailyRetrospectiveBudgetExhausted / recordDailyRetrospectiveRun", () => {
  beforeEach(() => {
    resetTable();
  });

  test("stays unexhausted while under the cap, then reports exhausted at the cap", () => {
    const cap = 40;
    for (let i = 0; i < cap; i += 1) {
      expect(isDailyRetrospectiveBudgetExhausted(cap, DAY1)).toBe(false);
      recordDailyRetrospectiveRun(cap, DAY1);
    }
    expect(getRetrospectiveDailyCount(DAY1)).toBe(cap);

    // The 41st attempt on the same UTC day sees an exhausted budget and, being
    // skipped, records nothing.
    expect(isDailyRetrospectiveBudgetExhausted(cap, DAY1_LATER)).toBe(true);
    expect(getRetrospectiveDailyCount(DAY1)).toBe(cap);
  });

  test("a new UTC day resets the count and prunes the prior day's row", () => {
    const cap = 40;
    for (let i = 0; i < cap; i += 1) {
      recordDailyRetrospectiveRun(cap, DAY1);
    }
    expect(isDailyRetrospectiveBudgetExhausted(cap, DAY1)).toBe(true);

    // First attempt on the next UTC day is allowed against a fresh count...
    expect(isDailyRetrospectiveBudgetExhausted(cap, DAY2)).toBe(false);
    recordDailyRetrospectiveRun(cap, DAY2);
    expect(getRetrospectiveDailyCount(DAY2)).toBe(1);

    // ...and the rollover opportunistically drops the stale prior-day row.
    expect(getRetrospectiveDailyCount(DAY1)).toBe(0);
    const remaining = getMemorySqlite()!
      .query<
        { n: number },
        []
      >(`SELECT COUNT(*) AS n FROM memory_retrospective_daily_count`)
      .get();
    expect(remaining?.n).toBe(1);
  });

  test("a non-positive cap is never exhausted and records nothing", () => {
    expect(isDailyRetrospectiveBudgetExhausted(0, DAY1)).toBe(false);
    expect(isDailyRetrospectiveBudgetExhausted(-5, DAY1)).toBe(false);
    recordDailyRetrospectiveRun(0, DAY1);
    recordDailyRetrospectiveRun(-5, DAY1);
    expect(getRetrospectiveDailyCount(DAY1)).toBe(0);
  });
});
