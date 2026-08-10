/**
 * Tests for the shared short-dollar formatter: whole dollars drop cents,
 * non-zero cents are kept, thousands get en-US separators (intentional for
 * USD amounts in every UI locale), negatives keep the sign outside the
 * dollar sign, and nullish or unparseable input renders "$0" rather than
 * leaking the raw string.
 */

import { describe, expect, test } from "bun:test";

import { formatUsdShort } from "./format-usd";

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
