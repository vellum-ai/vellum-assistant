/**
 * Tests for the short month-and-day the Plan tile's usage panel prints under
 * its title. The harness pins no `TZ`, so the instant is built from local noon
 * rather than a fixed UTC one: a fixed UTC noon is already the next day on
 * hosts east of UTC+12, which would move the expected calendar day.
 */

import { describe, expect, test } from "bun:test";

import { formatLocale } from "@/i18n";

import { formatUsageResetDate } from "./usage-reset-date";

const RESET_AT = new Date(2026, 8, 20, 12).toISOString();

describe("formatUsageResetDate", () => {
  test("prints a short month and day in en-US", () => {
    expect(formatUsageResetDate(RESET_AT, "en-US")).toBe("Sep 20");
  });

  test("keeps en-GB day-first", () => {
    expect(formatUsageResetDate(RESET_AT, "en-GB")).toMatch(/^20 Sept?$/);
  });

  test("names the month in the reader's language", () => {
    expect(formatUsageResetDate(RESET_AT, "fr-FR")).toContain("sept");
  });

  test("an unparseable value comes back untouched", () => {
    expect(formatUsageResetDate("not-a-date", "en-US")).toBe("not-a-date");
  });

  test("defaults to the formatting locale", () => {
    expect(formatUsageResetDate(RESET_AT)).toBe(
      formatUsageResetDate(RESET_AT, formatLocale()),
    );
  });
});
