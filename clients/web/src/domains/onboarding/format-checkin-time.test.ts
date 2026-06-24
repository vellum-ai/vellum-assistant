/**
 * Tests for formatCheckinTime, which turns the daemon's booked check-in start
 * (ISO) + an optional timeZone into a short wall-clock time for confirmation
 * copy. These pin the valid/empty/invalid contract and that a bad timeZone is
 * tolerated rather than thrown.
 */

import { describe, expect, test } from "bun:test";

import { formatCheckinTime } from "@/domains/onboarding/format-checkin-time";

describe("formatCheckinTime", () => {
  test("formats a valid instant in the supplied timeZone as a short time", () => {
    // 2024-01-15T19:30:00Z is 2:30 PM in America/New_York (EST, UTC-5).
    const result = formatCheckinTime(
      "2024-01-15T19:30:00Z",
      "America/New_York",
    );
    expect(result).toMatch(/^\d{1,2}:\d{2}\s?(AM|PM)$/i);
  });

  test("returns null for empty/invalid input", () => {
    expect(formatCheckinTime(undefined)).toBeNull();
    expect(formatCheckinTime("")).toBeNull();
    expect(formatCheckinTime("not-a-date")).toBeNull();
  });

  test("tolerates a bad timeZone and still returns a formatted string", () => {
    const result = formatCheckinTime("2024-01-15T19:30:00Z", "Not/AZone");
    expect(result).not.toBeNull();
    expect(typeof result).toBe("string");
  });
});
