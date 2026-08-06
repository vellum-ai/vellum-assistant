/**
 * Tests for `extractDrfFieldErrors`: DRF bodies flatten to one message per
 * field, and anything that isn't a field-keyed object yields `{}` so callers
 * fall back to their generic error copy.
 */

import { describe, expect, test } from "bun:test";

import { extractDrfFieldErrors } from "./drf-errors";

describe("extractDrfFieldErrors", () => {
  test("flattens a DRF field-error body to the first message per field", () => {
    expect(
      extractDrfFieldErrors({
        amount_usd: ["Must be between $10 and $500", "second message"],
        threshold_usd: ["Must be between $1 and $100"],
      }),
    ).toEqual({
      amount_usd: "Must be between $10 and $500",
      threshold_usd: "Must be between $1 and $100",
    });
  });

  test("returns an empty map for non-DRF error shapes", () => {
    expect(extractDrfFieldErrors(null)).toEqual({});
    expect(extractDrfFieldErrors(undefined)).toEqual({});
    expect(extractDrfFieldErrors(new Error("network"))).toEqual({});
    expect(extractDrfFieldErrors("boom")).toEqual({});
    expect(extractDrfFieldErrors(["a"])).toEqual({});
  });

  test("skips fields whose value is not a non-empty string array", () => {
    expect(
      extractDrfFieldErrors({
        good: ["kept"],
        empty: [],
        numeric: [42],
        scalar: "dropped",
      }),
    ).toEqual({ good: "kept" });
  });
});
