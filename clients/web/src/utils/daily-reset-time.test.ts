import { describe, expect, test } from "bun:test";

import { dailyResetTimePhrase } from "./daily-reset-time";

describe("dailyResetTimePhrase", () => {
  test("uses the generic zone abbreviation, not the DST-specific one", () => {
    expect(
      dailyResetTimePhrase("America/Denver", new Date("2026-07-15T10:00:00Z")),
    ).toBe("6:00 PM MT");
  });

  test("tracks DST: same zone shifts an hour in winter", () => {
    expect(
      dailyResetTimePhrase("America/Denver", new Date("2026-01-15T10:00:00Z")),
    ).toBe("5:00 PM MT");
  });

  test("handles half-hour offsets via the zone's fallback label", () => {
    expect(
      dailyResetTimePhrase("Asia/Kolkata", new Date("2026-07-15T10:00:00Z")),
    ).toBe("5:30 AM India Time");
  });

  test("UTC-aligned viewers get a plain GMT label", () => {
    expect(dailyResetTimePhrase("UTC", new Date("2026-07-15T10:00:00Z"))).toBe(
      "12:00 AM GMT",
    );
  });
});
