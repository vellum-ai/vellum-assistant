/**
 * Tests for the reset date the usage panels print: a short month and day, in
 * whichever language the reader has active.
 */

import { describe, expect, test } from "bun:test";

import { formatUsageResetDate } from "./usage-reset-date";

describe("formatUsageResetDate", () => {
  test("names the month short and the day bare", () => {
    expect(formatUsageResetDate("2026-09-01T00:00:00Z", "en-US")).toBe("Sep 1");
  });

  test("writes the same instant in the active language", () => {
    expect(formatUsageResetDate("2026-09-01T00:00:00Z", "fr-FR")).toContain(
      "sept",
    );
  });

  test("keeps the locale's own field order", () => {
    // en-GB puts the day first, which is the whole reason the language is
    // threaded through rather than assumed.
    expect(formatUsageResetDate("2026-09-14T00:00:00Z", "en-GB")).toMatch(
      /^14 Sep/,
    );
  });
});
