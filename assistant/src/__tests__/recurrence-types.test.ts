import { describe, expect, test } from "bun:test";

import {
  detectScheduleSyntax,
  normalizeScheduleSyntax,
} from "../schedule/recurrence-types.js";

describe("detectScheduleSyntax", () => {
  test("detects cron for standard 5-field expressions", () => {
    expect(detectScheduleSyntax("0 9 * * 1-5")).toBe("cron");
    expect(detectScheduleSyntax("*/5 * * * *")).toBe("cron");
    expect(detectScheduleSyntax("30 14 1 * *")).toBe("cron");
    expect(detectScheduleSyntax("0 0 * * 0")).toBe("cron");
  });

  test("detects RRULE for RRULE: prefix", () => {
    expect(detectScheduleSyntax("RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0")).toBe(
      "rrule",
    );
  });

  test("detects RRULE for DTSTART + RRULE multiline", () => {
    expect(
      detectScheduleSyntax("DTSTART:20250101T090000Z\nRRULE:FREQ=DAILY"),
    ).toBe("rrule");
  });

  test("detects RRULE for expression containing FREQ=", () => {
    expect(detectScheduleSyntax("FREQ=WEEKLY;BYDAY=MO,WE,FR")).toBe("rrule");
  });

  test("returns null for empty/invalid input", () => {
    expect(detectScheduleSyntax("")).toBeNull();
    expect(detectScheduleSyntax("   ")).toBeNull();
    expect(detectScheduleSyntax("hello world")).toBeNull();
    expect(
      detectScheduleSyntax("not a schedule expression at all and is long"),
    ).toBeNull();
  });

  test("returns null for ambiguous expressions", () => {
    // Single word that is not 5 fields and not RRULE
    expect(detectScheduleSyntax("daily")).toBeNull();
  });
});

describe("normalizeScheduleSyntax", () => {
  test("uses explicit syntax + expression when both provided", () => {
    const result = normalizeScheduleSyntax({
      syntax: "rrule",
      expression: "RRULE:FREQ=DAILY",
    });
    expect(result).toEqual({ syntax: "rrule", expression: "RRULE:FREQ=DAILY" });
  });

  test("auto-detects syntax from expression", () => {
    const cronResult = normalizeScheduleSyntax({ expression: "0 9 * * 1-5" });
    expect(cronResult).toEqual({ syntax: "cron", expression: "0 9 * * 1-5" });

    const rruleResult = normalizeScheduleSyntax({
      expression: "RRULE:FREQ=DAILY",
    });
    expect(rruleResult).toEqual({
      syntax: "rrule",
      expression: "RRULE:FREQ=DAILY",
    });
  });

  test("returns null when nothing is provided", () => {
    expect(normalizeScheduleSyntax({})).toBeNull();
  });

  test("returns null when expression is ambiguous and no syntax hint", () => {
    expect(normalizeScheduleSyntax({ expression: "daily" })).toBeNull();
  });

  test("trusts explicit syntax when auto-detection fails", () => {
    const result = normalizeScheduleSyntax({
      syntax: "cron",
      expression: "some-custom-expr",
    });
    expect(result).toEqual({ syntax: "cron", expression: "some-custom-expr" });
  });
});
