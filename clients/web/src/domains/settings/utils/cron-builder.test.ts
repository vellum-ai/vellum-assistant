import { describe, expect, test } from "bun:test";

import {
  buildCronExpression,
  type Cadence,
  describeCadence,
  DEFAULT_CADENCE,
  formatTimeOfDay,
  normalizeWeekdays,
} from "@/domains/settings/utils/cron-builder";

function cadence(overrides: Partial<Cadence>): Cadence {
  return { ...DEFAULT_CADENCE, ...overrides };
}

describe("buildCronExpression", () => {
  test("hourly fires at the chosen minute of every hour", () => {
    expect(buildCronExpression(cadence({ frequency: "hourly", minute: 30 }))).toBe(
      "30 * * * *",
    );
  });

  test("daily fires at the chosen time", () => {
    expect(
      buildCronExpression(
        cadence({ frequency: "daily", hour24: 9, minute: 0 }),
      ),
    ).toBe("0 9 * * *");
  });

  test("weekly joins selected weekdays in cron order", () => {
    expect(
      buildCronExpression(
        cadence({
          frequency: "weekly",
          hour24: 9,
          minute: 0,
          weekdays: [5, 1, 3],
        }),
      ),
    ).toBe("0 9 * * 1,3,5");
  });

  test("monthly fires on the chosen day of month", () => {
    expect(
      buildCronExpression(
        cadence({
          frequency: "monthly",
          hour24: 14,
          minute: 0,
          dayOfMonth: 15,
        }),
      ),
    ).toBe("0 14 15 * *");
  });

  test("monthly 'last' maps to cron L so short months are never skipped", () => {
    expect(
      buildCronExpression(
        cadence({
          frequency: "monthly",
          hour24: 9,
          minute: 0,
          dayOfMonth: "last",
        }),
      ),
    ).toBe("0 9 L * *");
  });

  test("clamps out-of-range values into valid cron fields", () => {
    // dayOfMonth caps at 28 — the simple builder never targets 29–31, which
    // would skip months that lack those dates.
    expect(
      buildCronExpression(
        cadence({ frequency: "monthly", hour24: 99, minute: -5, dayOfMonth: 99 }),
      ),
    ).toBe("0 23 28 * *");
  });
});

describe("normalizeWeekdays", () => {
  test("dedupes, sorts, and defaults to Monday when empty", () => {
    expect(normalizeWeekdays([3, 1, 3])).toEqual([1, 3]);
    expect(normalizeWeekdays([])).toEqual([1]);
  });
});

describe("formatTimeOfDay", () => {
  test("formats 12-hour clock with AM/PM", () => {
    expect(formatTimeOfDay(0, 0)).toBe("12:00 AM");
    expect(formatTimeOfDay(9, 5)).toBe("9:05 AM");
    expect(formatTimeOfDay(12, 30)).toBe("12:30 PM");
    expect(formatTimeOfDay(13, 0)).toBe("1:00 PM");
  });
});

describe("describeCadence", () => {
  test("hourly", () => {
    expect(describeCadence(cadence({ frequency: "hourly", minute: 0 }))).toBe(
      "Runs every hour at :00",
    );
  });

  test("daily", () => {
    expect(
      describeCadence(cadence({ frequency: "daily", hour24: 9, minute: 0 })),
    ).toBe("Runs every day at 9:00 AM");
  });

  test("weekly collapses Mon–Fri to 'every weekday'", () => {
    expect(
      describeCadence(
        cadence({ frequency: "weekly", weekdays: [1, 2, 3, 4, 5] }),
      ),
    ).toBe("Runs every weekday at 9:00 AM");
  });

  test("weekly collapses the full week to 'every day'", () => {
    expect(
      describeCadence(
        cadence({ frequency: "weekly", weekdays: [0, 1, 2, 3, 4, 5, 6] }),
      ),
    ).toBe("Runs every day at 9:00 AM");
  });

  test("weekly collapses Sat+Sun to 'every weekend'", () => {
    expect(
      describeCadence(cadence({ frequency: "weekly", weekdays: [0, 6] })),
    ).toBe("Runs every weekend at 9:00 AM");
  });

  test("weekly lists an arbitrary set of days", () => {
    expect(
      describeCadence(cadence({ frequency: "weekly", weekdays: [1, 3, 5] })),
    ).toBe("Runs every Mon, Wed & Fri at 9:00 AM");
  });

  test("monthly uses an ordinal day", () => {
    expect(
      describeCadence(
        cadence({ frequency: "monthly", dayOfMonth: 1, hour24: 9, minute: 0 }),
      ),
    ).toBe("Runs on the 1st of every month at 9:00 AM");
    expect(
      describeCadence(
        cadence({ frequency: "monthly", dayOfMonth: 22, hour24: 9, minute: 0 }),
      ),
    ).toBe("Runs on the 22nd of every month at 9:00 AM");
  });

  test("monthly 'last' reads as the last day", () => {
    expect(
      describeCadence(
        cadence({
          frequency: "monthly",
          dayOfMonth: "last",
          hour24: 9,
          minute: 0,
        }),
      ),
    ).toBe("Runs on the last day of every month at 9:00 AM");
  });
});
