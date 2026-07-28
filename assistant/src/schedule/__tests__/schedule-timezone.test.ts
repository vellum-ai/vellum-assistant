import { afterEach, describe, expect, mock, test } from "bun:test";

let mockUi: {
  userTimezone?: string | null;
  detectedTimezone?: string | null;
} = {};

mock.module("../../config/loader.js", () => ({
  getConfigReadOnly: () => ({ ui: mockUi }),
}));

const { resolveScheduleTimezone, expressionCarriesOwnTimezone } =
  await import("../schedule-timezone.js");

afterEach(() => {
  mockUi = {};
});

describe("resolveScheduleTimezone", () => {
  test("an explicit value wins and is canonicalized", () => {
    mockUi = { userTimezone: "America/New_York" };
    expect(resolveScheduleTimezone("America/Los_Angeles")).toBe(
      "America/Los_Angeles",
    );
  });

  test("falls back to the configured user timezone (beats detected)", () => {
    mockUi = {
      userTimezone: "America/New_York",
      detectedTimezone: "America/Chicago",
    };
    expect(resolveScheduleTimezone(null)).toBe("America/New_York");
  });

  test("falls back to the detected timezone when no user timezone is set", () => {
    mockUi = { detectedTimezone: "America/Chicago" };
    expect(resolveScheduleTimezone(undefined)).toBe("America/Chicago");
  });

  test("returns null when nothing is known (host-local is preserved)", () => {
    mockUi = {};
    expect(resolveScheduleTimezone(null)).toBeNull();
  });

  test("ignores an invalid explicit value and falls back", () => {
    mockUi = { userTimezone: "America/New_York" };
    expect(resolveScheduleTimezone("Not/AZone")).toBe("America/New_York");
  });
});

describe("expressionCarriesOwnTimezone", () => {
  test("cron never carries its own zone", () => {
    expect(expressionCarriesOwnTimezone("cron", "30 8 * * *")).toBe(false);
  });

  test("a plain RRULE does not carry its own zone", () => {
    expect(expressionCarriesOwnTimezone("rrule", "FREQ=DAILY;BYHOUR=8")).toBe(
      false,
    );
  });

  test("an RRULE with embedded DTSTART;TZID carries its own zone (not clobbered)", () => {
    expect(
      expressionCarriesOwnTimezone(
        "rrule",
        "DTSTART;TZID=America/Chicago:20240101T083000\nRRULE:FREQ=DAILY",
      ),
    ).toBe(true);
  });

  test("an RRULE with a Z-anchored UTC DTSTART carries its own zone", () => {
    expect(
      expressionCarriesOwnTimezone(
        "rrule",
        "DTSTART:20240101T083000Z\nRRULE:FREQ=DAILY",
      ),
    ).toBe(true);
  });

  test("an RRULE set-construct is treated as carrying its own zone", () => {
    // rrulestr does not thread a caller-supplied tzid into a constructed
    // RRuleSet, so resolving a zone for a set-construct would not change firing;
    // we therefore leave the timezone field alone for these.
    expect(
      expressionCarriesOwnTimezone(
        "rrule",
        "RRULE:FREQ=DAILY\nRDATE:20240101T083000",
      ),
    ).toBe(true);
  });

  // Deeper guarantee behind the set-construct exclusion above: the recurrence
  // engine's computeNextRunAt must not shift when a set-construct expression is
  // given an explicit timezone (proving the field genuinely has no effect, so a
  // future rrule upgrade that changes this is caught). Convert to a real test
  // when a set-construct fixture with a known epoch is added.
  test.todo(
    "computeNextRunAt is unaffected by an explicit tz on a set-construct expression",
    () => {},
  );
});
