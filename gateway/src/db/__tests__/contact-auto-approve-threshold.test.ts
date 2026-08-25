/**
 * Tests for the contact-row auto-approve threshold parser.
 *
 * Corrupt or unknown stored values fail closed to unset (null) so a bad
 * write cannot invent a ceiling the rest of the stack does not understand.
 */

import { describe, expect, test } from "bun:test";

import { parseContactAutoApproveThreshold } from "../contact-auto-approve-threshold.js";

describe("parseContactAutoApproveThreshold", () => {
  test("maps the RiskThreshold vocabulary", () => {
    expect(parseContactAutoApproveThreshold("none")).toBe("none");
    expect(parseContactAutoApproveThreshold("low")).toBe("low");
    expect(parseContactAutoApproveThreshold("medium")).toBe("medium");
    expect(parseContactAutoApproveThreshold("high")).toBe("high");
  });

  test("treats null and undefined as unset", () => {
    expect(parseContactAutoApproveThreshold(null)).toBeNull();
    expect(parseContactAutoApproveThreshold(undefined)).toBeNull();
  });

  test("treats unknown or malformed values as unset", () => {
    expect(parseContactAutoApproveThreshold("full")).toBeNull();
    expect(parseContactAutoApproveThreshold("HIGH")).toBeNull();
    expect(parseContactAutoApproveThreshold("")).toBeNull();
    expect(parseContactAutoApproveThreshold("relaxed")).toBeNull();
  });
});
