/**
 * Tests for the shared dollar formatters.
 *
 * `formatUsdShort`: whole dollars drop cents, non-zero cents are kept,
 * thousands get en-US separators (intentional for USD amounts in every UI
 * locale), negatives keep the sign outside the dollar sign, and nullish or
 * unparseable input renders "$0" rather than leaking the raw string.
 *
 * `formatUsd`: cents are always kept, a nullish amount returns null so the
 * caller can omit the clause, and an unparseable amount falls back to the raw
 * string behind a dollar sign.
 */

import { describe, expect, test } from "bun:test";

import { formatUsd, formatUsdShort } from "./format-usd";

describe("formatUsdShort", () => {
  test.each([
    ["5.00", "$5"],
    ["7.50", "$7.50"],
    ["1000.00", "$1,000"],
    ["1234.56", "$1,234.56"],
    ["0.00", "$0"],
    ["-5.00", "-$5"],
    ["-7.25", "-$7.25"],
  ])("formats %p as %p", (input, expected) => {
    expect(formatUsdShort(input)).toBe(expected);
  });

  test.each([null, undefined, "", "not-a-number"])(
    "renders $0 for %p",
    (input) => {
      expect(formatUsdShort(input)).toBe("$0");
    },
  );
});

describe("formatUsd", () => {
  test.each([
    ["5.00", "$5.00"],
    ["25.13", "$25.13"],
    ["1000", "$1000.00"],
  ])("formats %p as %p", (input, expected) => {
    expect(formatUsd(input)).toBe(expected);
  });

  test.each([null, undefined])("returns null for %p", (input) => {
    expect(formatUsd(input)).toBeNull();
  });

  test("falls back to the raw value when it cannot be parsed", () => {
    expect(formatUsd("not-a-number")).toBe("$not-a-number");
  });
});
