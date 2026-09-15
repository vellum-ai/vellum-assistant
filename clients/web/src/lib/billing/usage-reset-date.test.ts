/**
 * Tests for the short month-and-day the Plan tile's usage panel prints under
 * its title. Instants are noon UTC because the harness pins no `TZ`, so a
 * midnight instant would land on the previous day west of UTC.
 */

import { describe, expect, test } from "bun:test";

import { formatUsageResetDate } from "./usage-reset-date";

describe("formatUsageResetDate", () => {
  test("prints a short month and day in en-US", () => {
    expect(formatUsageResetDate("2026-09-20T12:00:00Z", "en-US")).toBe(
      "Sep 20",
    );
  });

  test("keeps en-GB day-first", () => {
    expect(formatUsageResetDate("2026-09-20T12:00:00Z", "en-GB")).toMatch(
      /^20 Sept?$/,
    );
  });

  test("names the month in the reader's language", () => {
    expect(formatUsageResetDate("2026-09-20T12:00:00Z", "fr-FR")).toContain(
      "sept",
    );
  });

  test("an unparseable value comes back untouched", () => {
    expect(formatUsageResetDate("not-a-date", "en-US")).toBe("not-a-date");
  });
});
