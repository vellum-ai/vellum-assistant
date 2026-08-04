import { describe, expect, test } from "bun:test";

import { dailyResetTimePhrase } from "./daily-reset-time";

describe("dailyResetTimePhrase", () => {
  test("collapses to plain UTC copy when the clock aligns with UTC", () => {
    expect(dailyResetTimePhrase("UTC", new Date("2026-07-15T10:00:00Z"))).toBe(
      "midnight UTC",
    );
  });

  test("renders the local reset hour for a DST-observing zone in summer", () => {
    expect(
      dailyResetTimePhrase("America/New_York", new Date("2026-07-15T10:00:00Z")),
    ).toBe("8:00 PM your time (midnight UTC)");
  });

  test("renders the local reset hour for a DST-observing zone in winter", () => {
    expect(
      dailyResetTimePhrase("America/New_York", new Date("2026-01-15T10:00:00Z")),
    ).toBe("7:00 PM your time (midnight UTC)");
  });

  test("handles half-hour offsets", () => {
    expect(
      dailyResetTimePhrase("Asia/Kolkata", new Date("2026-07-15T10:00:00Z")),
    ).toBe("5:30 AM your time (midnight UTC)");
  });
});
