import { describe, expect, test } from "bun:test";

import {
  computeNextRunAt,
  describeRRuleExpression,
  isSingleFireRRule,
  isValidScheduleExpression,
} from "../schedule/recurrence-engine.js";

describe("recurrence engine — cron", () => {
  test("validates valid cron expressions", () => {
    expect(
      isValidScheduleExpression({ syntax: "cron", expression: "0 9 * * 1-5" }),
    ).toBe(true);
    expect(
      isValidScheduleExpression({ syntax: "cron", expression: "*/5 * * * *" }),
    ).toBe(true);
  });

  test("rejects invalid cron expressions", () => {
    expect(
      isValidScheduleExpression({ syntax: "cron", expression: "not valid" }),
    ).toBe(false);
    expect(isValidScheduleExpression({ syntax: "cron", expression: "" })).toBe(
      false,
    );
  });

  test("computes next run for cron", () => {
    const now = Date.now();
    const next = computeNextRunAt(
      { syntax: "cron", expression: "* * * * *" },
      now,
    );
    expect(next).toBeGreaterThan(now - 1);
    // Next minute should be within 60 seconds
    expect(next - now).toBeLessThanOrEqual(60_000);
  });
});

describe("recurrence engine — rrule", () => {
  test("validates RRULE with DTSTART", () => {
    const expr =
      "DTSTART:20250101T090000Z\nRRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0";
    expect(
      isValidScheduleExpression({ syntax: "rrule", expression: expr }),
    ).toBe(true);
  });

  test("rejects RRULE without DTSTART", () => {
    expect(
      isValidScheduleExpression({
        syntax: "rrule",
        expression: "RRULE:FREQ=DAILY",
      }),
    ).toBe(false);
  });

  test("accepts RRULE set constructs", () => {
    const withExdate =
      "DTSTART:20250101T090000Z\nRRULE:FREQ=DAILY\nEXDATE:20250105T090000Z";
    expect(
      isValidScheduleExpression({ syntax: "rrule", expression: withExdate }),
    ).toBe(true);

    const withRdate =
      "DTSTART:20250101T090000Z\nRRULE:FREQ=DAILY\nRDATE:20250115T090000Z";
    expect(
      isValidScheduleExpression({ syntax: "rrule", expression: withRdate }),
    ).toBe(true);

    const multiRrule =
      "DTSTART:20250101T090000Z\nRRULE:FREQ=DAILY\nRRULE:FREQ=WEEKLY";
    expect(
      isValidScheduleExpression({ syntax: "rrule", expression: multiRrule }),
    ).toBe(true);
  });

  test("computes next run for RRULE with future DTSTART", () => {
    // Use a date far in the future to ensure the test is stable
    const futureDate = new Date("2099-01-01T09:00:00Z");
    const expr = "DTSTART:20990101T090000Z\nRRULE:FREQ=DAILY";
    const next = computeNextRunAt({ syntax: "rrule", expression: expr });
    expect(next).toBeGreaterThanOrEqual(futureDate.getTime());
  });

  test("throws when RRULE has no future runs (UNTIL in past)", () => {
    const expr =
      "DTSTART:20200101T090000Z\nRRULE:FREQ=DAILY;UNTIL=20200105T090000Z";
    expect(() =>
      computeNextRunAt({ syntax: "rrule", expression: expr }),
    ).toThrow(/no upcoming runs/);
  });

  test("throws for RRULE missing DTSTART in computeNextRunAt", () => {
    expect(() =>
      computeNextRunAt({ syntax: "rrule", expression: "RRULE:FREQ=DAILY" }),
    ).toThrow(/DTSTART/);
  });

  test("preserves TZID parameter values when normalizing lowercase prefixes", () => {
    // TZID contains case-sensitive timezone names (e.g. America/New_York)
    // that must not be uppercased during prefix normalization.
    const expr =
      "dtstart;TZID=America/New_York:20990601T090000\nrrule:FREQ=DAILY";
    expect(
      isValidScheduleExpression({ syntax: "rrule", expression: expr }),
    ).toBe(true);
    const next = computeNextRunAt({ syntax: "rrule", expression: expr });
    expect(next).toBeGreaterThan(Date.now());
  });

  test("computes next run for RRULE with EXDATE set construct", () => {
    const expr =
      "DTSTART:20990101T090000Z\nRRULE:FREQ=DAILY\nEXDATE:20990101T090000Z";
    const next = computeNextRunAt({ syntax: "rrule", expression: expr });
    // Should skip the excluded date and return January 2
    const jan2 = new Date("2099-01-02T09:00:00Z").getTime();
    expect(next).toBe(jan2);
  });
});

describe("recurrence engine — rrule display helpers", () => {
  const SINGLE_FIRE = "DTSTART:20990612T080000\nRRULE:FREQ=DAILY;COUNT=1";
  const WEEKLY = "DTSTART:20990612T080000\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE";

  test("isSingleFireRRule detects COUNT=1 rules", () => {
    expect(isSingleFireRRule(SINGLE_FIRE)).toBe(true);
    expect(isSingleFireRRule(WEEKLY)).toBe(false);
    expect(
      isSingleFireRRule("DTSTART:20990612T080000\nRRULE:FREQ=DAILY;COUNT=2"),
    ).toBe(false);
    expect(isSingleFireRRule("not an rrule")).toBe(false);
  });

  test("isSingleFireRRule is false for set constructs", () => {
    expect(
      isSingleFireRRule(
        "DTSTART:20990612T080000\nRRULE:FREQ=DAILY;COUNT=1\nRDATE:20990613T080000",
      ),
    ).toBe(false);
  });

  test("describeRRuleExpression humanizes rules", () => {
    expect(describeRRuleExpression(SINGLE_FIRE)).toBe("One-time");
    expect(describeRRuleExpression(WEEKLY)).toBe(
      "Every week on Monday, Wednesday",
    );
    expect(
      describeRRuleExpression(
        "DTSTART:20990612T080000\nRRULE:FREQ=DAILY;COUNT=3",
      ),
    ).toBe("Every day for 3 times");
  });

  test("describeRRuleExpression falls back instead of leaking raw text", () => {
    expect(
      describeRRuleExpression(
        "DTSTART:20990612T080000\nRRULE:FREQ=DAILY\nEXDATE:20990613T080000",
      ),
    ).toBe("Custom recurrence");
    expect(describeRRuleExpression("garbage")).toBe("Custom recurrence");
  });
});
