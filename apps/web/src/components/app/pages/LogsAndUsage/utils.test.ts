import { describe, expect, test } from "bun:test";

import {
  resolveRangeWindow,
  resolveUsageGranularity,
} from "@/components/app/pages/LogsAndUsage/utils.js";
import type { UsageTimeRange } from "@/lib/usage/types.js";

const now = new Date(2026, 4, 14, 15, 30, 45, 123);

function localMidnight(daysBeforeToday: number): number {
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - daysBeforeToday,
  ).getTime();
}

describe("resolveRangeWindow", () => {
  test.each([
    ["today", 0],
    ["7d", 6],
    ["30d", 29],
    ["90d", 89],
  ] as Array<[UsageTimeRange, number]>)(
    "anchors %s to the expected local midnight",
    (range, daysBeforeToday) => {
      expect(resolveRangeWindow(range, now)).toEqual({
        from: localMidnight(daysBeforeToday),
        to: now.getTime(),
      });
    },
  );

  test("keeps all time open-ended from epoch to now", () => {
    expect(resolveRangeWindow("all", now)).toEqual({
      from: 0,
      to: now.getTime(),
    });
  });
});

describe("resolveUsageGranularity", () => {
  test.each([
    ["today", "hourly"],
    ["7d", "daily"],
    ["30d", "daily"],
    ["90d", "daily"],
    ["all", "daily"],
  ] as const)("maps %s to %s", (range, granularity) => {
    expect(resolveUsageGranularity(range)).toBe(granularity);
  });
});
