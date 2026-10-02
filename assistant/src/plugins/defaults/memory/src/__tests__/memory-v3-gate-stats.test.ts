/**
 * Tests for `handleMemoryV3GateStats` in `memory-v3-routes.ts`.
 *
 * The handler aggregates gate telemetry from the telemetry DB and buckets it
 * by concept page count. These tests cover:
 *   - empty DB returns zero counts, all buckets present, scoredPassRate null
 *   - mixed rows land in the correct buckets by real_concept_page_count
 *   - scored vs unscored runs are counted separately
 *   - rows with no real_concept_page_count go to unknownPageCount
 *   - lookbackDays is clamped to [1, 90]
 *   - malformed JSON rows are skipped
 *   - null/absent DB returns a zero response
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { handleMemoryV3GateStats } from "../memory-v3-routes.js";

// ---------------------------------------------------------------------------
// Minimal fake SQLite DB that returns pre-set rows
// ---------------------------------------------------------------------------

type FakeRow = { payload: string };

function makePayload(detail: Record<string, unknown>): string {
  return JSON.stringify({
    type: "watchdog",
    daemon_event_id: "test-id",
    recorded_at: Date.now(),
    check_name: "memory_v3_injection_gate",
    value: 1,
    detail,
  });
}

function fakeDb(rows: FakeRow[]): Database {
  return {
    query: (_sql: string) => ({
      all: (..._args: unknown[]) => rows,
    }),
  } as unknown as Database;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleMemoryV3GateStats", () => {
  test("returns zero counts with all buckets when DB is null", () => {
    const result = handleMemoryV3GateStats(30, null);
    expect(result.totalRuns).toBe(0);
    expect(result.buckets).toHaveLength(4);
    for (const bucket of result.buckets) {
      expect(bucket.total).toBe(0);
      expect(bucket.scored).toBe(0);
      expect(bucket.passed).toBe(0);
      expect(bucket.scoredPassRate).toBeNull();
      expect(bucket.reasons).toEqual({});
    }
    expect(result.unknownPageCount).toEqual({
      total: 0,
      passed: 0,
      reasons: {},
    });
  });

  test("returns zero counts with all buckets when DB returns no rows", () => {
    const result = handleMemoryV3GateStats(30, fakeDb([]));
    expect(result.totalRuns).toBe(0);
    expect(result.buckets[0]!.pageCountRange).toBe("0–9");
    expect(result.buckets[3]!.pageCountRange).toBe("200+");
    for (const b of result.buckets) {
      expect(b.scoredPassRate).toBeNull();
    }
  });

  test("buckets a dense_pass row into 10-49 bucket", () => {
    const rows = [
      {
        payload: makePayload({
          pass: true,
          reason: "dense_pass",
          scored: true,
          real_concept_page_count: 25,
        }),
      },
    ];
    const result = handleMemoryV3GateStats(30, fakeDb(rows));
    expect(result.totalRuns).toBe(1);
    const bucket = result.buckets.find((b) => b.pageCountRange === "10–49")!;
    expect(bucket.total).toBe(1);
    expect(bucket.scored).toBe(1);
    expect(bucket.passed).toBe(1);
    expect(bucket.scoredPassRate).toBe(1);
    expect(bucket.reasons).toEqual({ dense_pass: 1 });
  });

  test("buckets a fail row into 200+ bucket", () => {
    const rows = [
      {
        payload: makePayload({
          pass: false,
          reason: "fail_no_signal",
          scored: true,
          real_concept_page_count: 350,
        }),
      },
    ];
    const result = handleMemoryV3GateStats(30, fakeDb(rows));
    const bucket = result.buckets.find((b) => b.pageCountRange === "200+")!;
    expect(bucket.total).toBe(1);
    expect(bucket.passed).toBe(0);
    expect(bucket.scoredPassRate).toBe(0);
    expect(bucket.reasons).toEqual({ fail_no_signal: 1 });
  });

  test("unscored pass-open rows count in total but not scored", () => {
    const rows = [
      {
        payload: makePayload({
          pass: true,
          reason: "dense_unavailable",
          scored: false,
          real_concept_page_count: 5,
        }),
      },
    ];
    const result = handleMemoryV3GateStats(30, fakeDb(rows));
    const bucket = result.buckets.find((b) => b.pageCountRange === "0–9")!;
    expect(bucket.total).toBe(1);
    expect(bucket.scored).toBe(0);
    expect(bucket.passed).toBe(1);
    // No scored runs: scoredPassRate is null (unscored pass does not count)
    expect(bucket.scoredPassRate).toBeNull();
  });

  test("unscored pass mixed with scored fail does not inflate scoredPassRate", () => {
    // Regression: before fix, pass-open + scored-fail in same bucket gave 100%
    const rows = [
      {
        payload: makePayload({
          pass: true,
          reason: "dense_unavailable",
          scored: false,
          real_concept_page_count: 30,
        }),
      },
      {
        payload: makePayload({
          pass: false,
          reason: "fail_no_signal",
          scored: true,
          real_concept_page_count: 40,
        }),
      },
    ];
    const result = handleMemoryV3GateStats(30, fakeDb(rows));
    const bucket = result.buckets.find((b) => b.pageCountRange === "10–49")!;
    expect(bucket.total).toBe(2);
    expect(bucket.scored).toBe(1);
    expect(bucket.passed).toBe(1); // total passes (scored + unscored)
    // Only the scored fail counts toward the rate: no scored passes
    expect(bucket.scoredPassRate).toBe(0);
  });

  test("rows with no real_concept_page_count go to unknownPageCount", () => {
    const rows = [
      {
        payload: makePayload({
          pass: false,
          reason: "fail_no_signal",
          scored: true,
        }),
      },
    ];
    const result = handleMemoryV3GateStats(30, fakeDb(rows));
    expect(result.unknownPageCount.total).toBe(1);
    expect(result.unknownPageCount.passed).toBe(0);
    expect(result.unknownPageCount.reasons).toEqual({ fail_no_signal: 1 });
    for (const b of result.buckets) {
      expect(b.total).toBe(0);
    }
  });

  test("mixed rows across multiple buckets are aggregated correctly", () => {
    const rows: FakeRow[] = [
      // 0-9 bucket: 1 unscored pass
      {
        payload: makePayload({
          pass: true,
          reason: "dense_disabled",
          scored: false,
          real_concept_page_count: 3,
        }),
      },
      // 10-49 bucket: 1 pass, 1 fail (both scored)
      {
        payload: makePayload({
          pass: true,
          reason: "dense_pass",
          scored: true,
          real_concept_page_count: 20,
        }),
      },
      {
        payload: makePayload({
          pass: false,
          reason: "fail_no_signal",
          scored: true,
          real_concept_page_count: 45,
        }),
      },
      // 50-199 bucket: 2 passes
      {
        payload: makePayload({
          pass: true,
          reason: "sparse_only_strong",
          scored: true,
          real_concept_page_count: 100,
        }),
      },
      {
        payload: makePayload({
          pass: true,
          reason: "dense_pass",
          scored: true,
          real_concept_page_count: 150,
        }),
      },
    ];

    const result = handleMemoryV3GateStats(30, fakeDb(rows));
    expect(result.totalRuns).toBe(5);

    const b09 = result.buckets.find((b) => b.pageCountRange === "0–9")!;
    expect(b09.total).toBe(1);
    expect(b09.scored).toBe(0);
    expect(b09.scoredPassRate).toBeNull();

    const b1049 = result.buckets.find((b) => b.pageCountRange === "10–49")!;
    expect(b1049.total).toBe(2);
    expect(b1049.scored).toBe(2);
    expect(b1049.passed).toBe(1);
    expect(b1049.scoredPassRate).toBe(0.5);
    expect(b1049.reasons).toEqual({ dense_pass: 1, fail_no_signal: 1 });

    const b50199 = result.buckets.find((b) => b.pageCountRange === "50–199")!;
    expect(b50199.scored).toBe(2);
    expect(b50199.passed).toBe(2);
    expect(b50199.scoredPassRate).toBe(1);
  });

  test("lookbackDays is clamped to 1-90", () => {
    const r1 = handleMemoryV3GateStats(0, fakeDb([]));
    expect(r1.lookbackDays).toBe(1);
    const r2 = handleMemoryV3GateStats(999, fakeDb([]));
    expect(r2.lookbackDays).toBe(90);
    const r3 = handleMemoryV3GateStats(30, fakeDb([]));
    expect(r3.lookbackDays).toBe(30);
  });

  test("malformed JSON payload rows are skipped", () => {
    const rows: FakeRow[] = [
      { payload: "not-valid-json" },
      {
        payload: makePayload({
          pass: true,
          reason: "dense_pass",
          scored: true,
          real_concept_page_count: 25,
        }),
      },
    ];
    const result = handleMemoryV3GateStats(30, fakeDb(rows));
    // totalRuns counts raw rows before parse
    expect(result.totalRuns).toBe(2);
    const bucket = result.buckets.find((b) => b.pageCountRange === "10–49")!;
    expect(bucket.total).toBe(1);
  });
});
