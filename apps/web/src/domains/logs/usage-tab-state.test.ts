import { describe, expect, test } from "bun:test";

import {
  timezoneDayStartEpoch,
  toTimezoneDateString,
} from "@/components/charts/format-date-label";
import {
  buildUsageSearchParams,
  readUsageUrlState,
  resolveRangeWindow,
} from "@/domains/logs/usage-tab-state";

const UTC = "UTC";

/** Render an instant's wall clock in `tz` as "YYYY-MM-DD HH:MM:SS". */
function wallClock(epochMs: number, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(epochMs));
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get(
    "minute",
  )}:${get("second")}`;
}

describe("timezoneDayStartEpoch", () => {
  test("DST-start day in Sydney resolves to local midnight, not 23:00 prior", () => {
    // 2027-10-03 is a DST-start (spring-forward) date in Sydney. The naive
    // offset-at-UTC-midnight approach returned 2027-10-02 23:00 here.
    const epoch = timezoneDayStartEpoch("2027-10-03", "Australia/Sydney");
    expect(wallClock(epoch, "Australia/Sydney")).toBe("2027-10-03 00:00:00");
  });

  test("non-DST-boundary date in a fixed-offset zone is the obvious instant", () => {
    // Asia/Kolkata is a fixed UTC+5:30 zone with no DST.
    const epoch = timezoneDayStartEpoch("2026-06-02", "Asia/Kolkata");
    // Local midnight is 18:30 UTC the previous day.
    expect(epoch).toBe(Date.UTC(2026, 5, 1, 18, 30, 0));
    expect(wallClock(epoch, "Asia/Kolkata")).toBe("2026-06-02 00:00:00");
  });

  test("DST-end (fall-back) day resolves to the correct local midnight", () => {
    // 2027-04-04 is a DST-end (fall-back) date in Sydney.
    const epoch = timezoneDayStartEpoch("2027-04-04", "Australia/Sydney");
    expect(wallClock(epoch, "Australia/Sydney")).toBe("2027-04-04 00:00:00");
  });

  test("spring-forward that skips local midnight resolves to the first valid instant", () => {
    // 2026-09-06 is a DST-start date in Santiago where the clock jumps from
    // 23:59:59 (Sep 5) straight to 01:00:00 (Sep 6): local midnight never
    // exists. The two-pass guess lands on 2026-09-05 23:00 (prior day); the
    // gap fix must instead return the first valid instant ON 2026-09-06.
    const epoch = timezoneDayStartEpoch("2026-09-06", "America/Santiago");
    // First valid local time on the requested date is 01:00:00.
    expect(wallClock(epoch, "America/Santiago")).toBe("2026-09-06 01:00:00");
    // The formatted calendar date is the requested date, not the prior day.
    expect(toTimezoneDateString(new Date(epoch), "America/Santiago")).toBe(
      "2026-09-06",
    );
    // And the instant is at/after the transition (not before it).
    expect(epoch).toBe(Date.UTC(2026, 8, 6, 4, 0, 0));
  });

  test("UTC date resolves to UTC midnight", () => {
    expect(timezoneDayStartEpoch("2026-06-02", UTC)).toBe(
      Date.UTC(2026, 5, 2, 0, 0, 0),
    );
  });
});

describe("resolveRangeWindow", () => {
  test("'all' returns from=0 and to=now regardless of tz", () => {
    const now = Date.UTC(2026, 5, 2, 12, 0, 0);
    expect(resolveRangeWindow("all", "America/New_York", now)).toEqual({
      from: 0,
      to: now,
    });
  });

  test("'to' is the current instant; 'today' from is zone-local midnight", () => {
    const now = Date.UTC(2026, 5, 2, 18, 30, 0);
    const { from, to } = resolveRangeWindow("today", UTC, now);
    expect(to).toBe(now);
    // UTC midnight of 2026-06-02
    expect(from).toBe(Date.UTC(2026, 5, 2, 0, 0, 0));
  });

  test("'7d' from is six zone-local days before today (UTC)", () => {
    const now = Date.UTC(2026, 5, 2, 18, 30, 0);
    const { from } = resolveRangeWindow("7d", UTC, now);
    expect(from).toBe(Date.UTC(2026, 4, 27, 0, 0, 0));
  });

  test("day boundaries are computed in the supplied tz", () => {
    // An instant where the calendar day differs across far-apart zones.
    // 2026-06-02T01:00:00Z: UTC+14 (Kiritimati) is already 2026-06-02 15:00,
    // while UTC-11 (Niue) is still 2026-06-01 14:00.
    const now = Date.UTC(2026, 5, 2, 1, 0, 0);

    const east = resolveRangeWindow("today", "Pacific/Kiritimati", now);
    const west = resolveRangeWindow("today", "Pacific/Niue", now);

    // Different calendar "today" => different from-boundaries.
    expect(east.from).not.toBe(west.from);

    // Sanity-check the actual calendar dates the boundaries land on.
    expect(toTimezoneDateString(new Date(east.from), "Pacific/Kiritimati")).toBe(
      "2026-06-02",
    );
    expect(toTimezoneDateString(new Date(west.from), "Pacific/Niue")).toBe(
      "2026-06-01",
    );
  });

  test("from epoch maps back to zone-local midnight (DST-safe)", () => {
    // US DST is in effect in June; verify the from-boundary is local midnight.
    const now = Date.UTC(2026, 5, 2, 18, 0, 0);
    const tz = "America/New_York";
    const { from } = resolveRangeWindow("7d", tz, now);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(from));
    const hour = parts.find((p) => p.type === "hour")?.value;
    const minute = parts.find((p) => p.type === "minute")?.value;
    expect(`${hour}:${minute}`).toBe("00:00");
  });
});

describe("usage URL state", () => {
  test("reads valid range, group-by, and schedule id params", () => {
    const params = new URLSearchParams(
      "range=today&groupBy=schedule&scheduleId=schedule-123",
    );

    expect(readUsageUrlState(params)).toEqual({
      range: "today",
      groupBy: "schedule",
      scheduleId: "schedule-123",
    });
  });

  test("falls back for invalid range and group-by params", () => {
    const params = new URLSearchParams(
      "range=yesterday&groupBy=not-real&scheduleId=",
    );

    expect(readUsageUrlState(params)).toEqual({
      range: "7d",
      groupBy: "task",
      scheduleId: undefined,
    });
  });

  test("ignores schedule id params outside schedule grouping", () => {
    const params = new URLSearchParams(
      "range=7d&groupBy=task&scheduleId=schedule-123",
    );

    expect(readUsageUrlState(params)).toEqual({
      range: "7d",
      groupBy: "task",
      scheduleId: undefined,
    });
  });

  test("updates range without dropping group-by, schedule, or unrelated params", () => {
    const params = buildUsageSearchParams(
      new URLSearchParams(
        "groupBy=schedule&scheduleId=schedule-123&debug=true",
      ),
      { range: "30d" },
    );

    expect(params.toString()).toBe(
      "groupBy=schedule&scheduleId=schedule-123&debug=true&range=30d",
    );
  });

  test("updates group-by away from schedule and drops the schedule filter", () => {
    const params = buildUsageSearchParams(
      new URLSearchParams("range=90d&groupBy=schedule&scheduleId=schedule-123"),
      { groupBy: "profile" },
    );

    expect(params.toString()).toBe("range=90d&groupBy=profile");
  });

  test("updates group-by to schedule without dropping a schedule filter", () => {
    const params = buildUsageSearchParams(
      new URLSearchParams("range=90d&groupBy=task&scheduleId=schedule-123"),
      { groupBy: "schedule" },
    );

    expect(params.toString()).toBe(
      "range=90d&groupBy=schedule&scheduleId=schedule-123",
    );
  });

  test("clears only the schedule filter", () => {
    const params = buildUsageSearchParams(
      new URLSearchParams("range=90d&groupBy=schedule&scheduleId=schedule-123"),
      { scheduleId: null },
    );

    expect(params.toString()).toBe("range=90d&groupBy=schedule");
  });
});
