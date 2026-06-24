import { describe, expect, test } from "bun:test";

import type {
  ScheduleRun,
  ScheduleUsageSummary,
} from "@/domains/settings/types/schedules";

import {
  summarizeRunsForUsage,
  systemTaskUsageCost,
  SYSTEM_TASK_URL_IDS,
  totalUsageCost,
} from "./schedule-formatters";

function summary(
  scheduleId: string,
  totalEstimatedCostUsd: number,
): ScheduleUsageSummary {
  return {
    scheduleId,
    runCount: 1,
    totalEstimatedCostUsd,
    eventCount: 0,
  };
}

function run(overrides: Partial<ScheduleRun> = {}): ScheduleRun {
  return {
    id: "run-1",
    status: "ok",
    startedAt: 1_761_792_000_000,
    createdAt: 1_761_792_000_000,
    estimatedCostUsd: 0,
    ...overrides,
  } as ScheduleRun;
}

describe("totalUsageCost", () => {
  test("returns 0 for an empty array", () => {
    expect(totalUsageCost([])).toBe(0);
  });

  test("returns 0 for undefined", () => {
    expect(totalUsageCost(undefined)).toBe(0);
  });

  test("sums totalEstimatedCostUsd across multiple summaries", () => {
    expect(
      totalUsageCost([summary("a", 1.25), summary("b", 2.5), summary("c", 0)]),
    ).toBeCloseTo(3.75);
  });

  test("skips non-finite cost entries", () => {
    expect(
      totalUsageCost([
        summary("a", 1),
        summary("b", Number.NaN),
        summary("c", Infinity),
        summary("d", -Infinity),
        summary("e", 2),
      ]),
    ).toBe(3);
  });
});

describe("systemTaskUsageCost", () => {
  test("returns 0 while loading", () => {
    expect(systemTaskUsageCost({ status: "loading" })).toBe(0);
  });

  test("returns 0 on error", () => {
    expect(systemTaskUsageCost({ status: "error" })).toBe(0);
  });

  test("returns the summary cost when ready", () => {
    expect(
      systemTaskUsageCost({ status: "ready", summary: summary("a", 4.5) }),
    ).toBe(4.5);
  });

  test("returns 0 when ready summary cost is falsy", () => {
    expect(
      systemTaskUsageCost({ status: "ready", summary: summary("a", 0) }),
    ).toBe(0);
  });
});

describe("summarizeRunsForUsage", () => {
  test("ignores skipped no-op attempts in run counts", () => {
    const summary = summarizeRunsForUsage(
      SYSTEM_TASK_URL_IDS.heartbeat,
      [
        run({
          id: "heartbeat-ok",
          status: "ok",
          estimatedCostUsd: 0.02,
        }),
        run({
          id: "heartbeat-skipped",
          status: "skipped",
          startedAt: 1_761_792_010_000,
          createdAt: 1_761_792_010_000,
          estimatedCostUsd: 0,
        }),
      ],
      { from: 1_761_791_000_000, to: 1_761_793_000_000 },
    );

    expect(summary).toEqual({
      scheduleId: SYSTEM_TASK_URL_IDS.heartbeat,
      runCount: 1,
      totalEstimatedCostUsd: 0.02,
      eventCount: 0,
    });
  });
});
