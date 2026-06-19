import { describe, expect, test } from "bun:test";

import { timezoneDayStartEpoch } from "@/components/charts/format-date-label";

import { resolveScheduleUsageWindow } from "./schedule-usage-window";

describe("resolveScheduleUsageWindow", () => {
  test("matches the usage page's 7d window semantics in UTC", () => {
    const now = Date.UTC(2026, 5, 2, 18, 30, 0);

    expect(resolveScheduleUsageWindow("UTC", now)).toEqual({
      from: Date.UTC(2026, 4, 27, 0, 0, 0),
      to: now,
    });
  });

  test("uses zone-local midnight for the first day of the 7d window", () => {
    const now = Date.UTC(2026, 5, 2, 18, 0, 0);
    const window = resolveScheduleUsageWindow("America/New_York", now);

    expect(window.to).toBe(now);
    expect(window.from).toBe(
      timezoneDayStartEpoch("2026-05-27", "America/New_York"),
    );
    expect(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(new Date(window.from)),
    ).toBe("00:00");
  });
});
