/**
 * Tests for the per-UTC-day, per-counter run tally backing memory background-job
 * daily caps. Storage lives on the dedicated memory database
 * (`assistant-memory.db`); these exercise the real connection, plus a fail-open
 * path that stands in a connection with no underlying sqlite client.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { DrizzleDb } from "../../../../persistence/db-connection.js";
import { getMemorySqlite } from "../../../../persistence/db-connection.js";
import { initializeDb } from "../../../../persistence/db-init.js";
import {
  clearStoredDb,
  setStoredDb,
} from "../../../../persistence/db-singleton.js";
import {
  getDailyRunCount,
  recordDailyRun,
  utcDay,
} from "../daily-run-counter.js";

await initializeDb();

const CONSOLIDATION = "memory_v2_consolidate_daily_runs";
const RETROSPECTIVE = "memory_retrospective_daily_runs";

const DAY1_NOON = Date.UTC(2026, 6, 22, 12, 0, 0);
const DAY1_LATE = Date.UTC(2026, 6, 22, 23, 30, 0); // same UTC day as DAY1_NOON
const DAY2_NOON = Date.UTC(2026, 6, 23, 12, 0, 0); // next UTC day

function resetTable(): void {
  getMemorySqlite()!.exec(`DELETE FROM memory_daily_run_count`);
}

function rowCount(): number {
  return (
    getMemorySqlite()!
      .query<
        { n: number },
        []
      >(`SELECT COUNT(*) AS n FROM memory_daily_run_count`)
      .get()?.n ?? 0
  );
}

describe("utcDay", () => {
  test("keys by UTC calendar day, ignoring wall-clock time", () => {
    expect(utcDay(DAY1_NOON)).toBe("2026-07-22");
    expect(utcDay(DAY1_LATE)).toBe("2026-07-22");
    expect(utcDay(DAY2_NOON)).toBe("2026-07-23");
  });
});

describe("getDailyRunCount / recordDailyRun", () => {
  beforeEach(() => {
    resetTable();
  });

  test("counts runs within the current UTC day and returns the running total", () => {
    expect(getDailyRunCount(CONSOLIDATION, DAY1_NOON)).toBe(0);
    expect(recordDailyRun(CONSOLIDATION, DAY1_NOON)).toBe(1);
    expect(recordDailyRun(CONSOLIDATION, DAY1_LATE)).toBe(2);
    expect(getDailyRunCount(CONSOLIDATION, DAY1_NOON)).toBe(2);
  });

  test("namespacing: two counters keep independent tallies", () => {
    recordDailyRun(CONSOLIDATION, DAY1_NOON);
    recordDailyRun(CONSOLIDATION, DAY1_NOON);
    recordDailyRun(RETROSPECTIVE, DAY1_NOON);

    expect(getDailyRunCount(CONSOLIDATION, DAY1_NOON)).toBe(2);
    expect(getDailyRunCount(RETROSPECTIVE, DAY1_NOON)).toBe(1);
    // One row per (counter, day_key).
    expect(rowCount()).toBe(2);
  });

  test("the tally resets at the UTC day boundary", () => {
    recordDailyRun(CONSOLIDATION, DAY1_NOON);
    recordDailyRun(CONSOLIDATION, DAY1_NOON);
    expect(getDailyRunCount(CONSOLIDATION, DAY1_NOON)).toBe(2);

    // A new UTC day reads zero and starts a fresh count at one.
    expect(getDailyRunCount(CONSOLIDATION, DAY2_NOON)).toBe(0);
    expect(recordDailyRun(CONSOLIDATION, DAY2_NOON)).toBe(1);
  });

  test("the first run of a new day prunes that counter's stale rows", () => {
    recordDailyRun(CONSOLIDATION, DAY1_NOON);
    recordDailyRun(CONSOLIDATION, DAY1_NOON);

    recordDailyRun(CONSOLIDATION, DAY2_NOON);

    // The prior-day row is gone; only the new day's row remains for the counter.
    expect(getDailyRunCount(CONSOLIDATION, DAY1_NOON)).toBe(0);
    expect(rowCount()).toBe(1);
  });

  test("the prune is scoped to the recorded counter", () => {
    // Both counters have a DAY1 row.
    recordDailyRun(CONSOLIDATION, DAY1_NOON);
    recordDailyRun(RETROSPECTIVE, DAY1_NOON);

    // Recording CONSOLIDATION on DAY2 prunes only CONSOLIDATION's DAY1 row.
    recordDailyRun(CONSOLIDATION, DAY2_NOON);

    expect(getDailyRunCount(CONSOLIDATION, DAY1_NOON)).toBe(0);
    // RETROSPECTIVE's DAY1 row is untouched.
    expect(getDailyRunCount(RETROSPECTIVE, DAY1_NOON)).toBe(1);
  });
});

describe("daily-run-counter without a memory database", () => {
  // Install a connection with no underlying sqlite client so getMemorySqlite()
  // resolves to null without mocking any module.
  beforeEach(() => {
    setStoredDb("memory", { $client: null } as unknown as DrizzleDb, () => {});
  });

  afterEach(() => {
    clearStoredDb("memory");
  });

  test("getDailyRunCount reads zero (cap fails open)", () => {
    expect(getDailyRunCount(CONSOLIDATION, DAY1_NOON)).toBe(0);
  });

  test("recordDailyRun no-ops, returns zero, and never throws", () => {
    expect(() => recordDailyRun(CONSOLIDATION, DAY1_NOON)).not.toThrow();
    expect(recordDailyRun(CONSOLIDATION, DAY1_NOON)).toBe(0);
  });
});
