import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { formatRelativeTime } from "./relative-time";

const realDateNow = Date.now;
const NOW = new Date("2026-08-17T12:00:00.000Z").getTime();

beforeEach(() => {
  Date.now = () => NOW;
});

afterAll(() => {
  Date.now = realDateNow;
});

describe("formatRelativeTime", () => {
  test("picks the largest fitting unit, past and future", () => {
    expect(formatRelativeTime(NOW - 2 * 60_000, { locale: "en" })).toBe("2 minutes ago");
    expect(formatRelativeTime(NOW + 3 * 60 * 60_000, { locale: "en" })).toBe("in 3 hours");
    // numeric: "auto" phrases single units idiomatically.
    expect(
      formatRelativeTime(NOW - 8 * 24 * 60 * 60_000, { locale: "en" }),
    ).toBe("last week");
  });

  test("rounds within the chosen unit (Math.round semantics)", () => {
    expect(formatRelativeTime(NOW - 90_000, { locale: "en" })).toBe(
      "1 minute ago",
    );
    expect(formatRelativeTime(NOW - 91_000, { locale: "en" })).toBe(
      "2 minutes ago",
    );
  });

  test("phrases sub-minimum-unit differences as now", () => {
    expect(formatRelativeTime(NOW - 45_000, { locale: "en", minimumUnit: "minute" })).toBe(
      "now",
    );
    expect(formatRelativeTime(NOW - 45_000, { locale: "en" })).toBe("45 seconds ago");
  });

  test("formats in the requested locale", () => {
    expect(formatRelativeTime(NOW - 2 * 60_000, { locale: "es" })).toBe(
      "hace 2 minutos",
    );
  });
});
