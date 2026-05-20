import { describe, expect, test } from "bun:test";
import { getProvenanceText, wasExpected } from "@/domains/chat/utils/risk-utils.js";

describe("wasExpected", () => {
  test("prompted mode is always expected", () => {
    expect(wasExpected("prompted", "high", "none")).toBe(true);
    expect(wasExpected("prompted", "high", "low")).toBe(true);
  });

  test("blocked mode is always expected", () => {
    expect(wasExpected("blocked", "high", "none")).toBe(true);
    expect(wasExpected("blocked", "medium", "low")).toBe(true);
  });

  test("unknown (legacy) mode is always expected", () => {
    expect(wasExpected("unknown", "high", "none")).toBe(true);
  });

  test("auto: risk within threshold → expected", () => {
    expect(wasExpected("auto", "low",    "low")).toBe(true);
    expect(wasExpected("auto", "low",    "medium")).toBe(true);
    expect(wasExpected("auto", "medium", "medium")).toBe(true);
    expect(wasExpected("auto", "high",   "high")).toBe(true);
  });

  test("auto: risk above threshold → unexpected", () => {
    expect(wasExpected("auto", "high",    "low")).toBe(false);
    expect(wasExpected("auto", "high",    "medium")).toBe(false);
    expect(wasExpected("auto", "medium",  "low")).toBe(false);
    expect(wasExpected("auto", "high",    "none")).toBe(false);
    expect(wasExpected("auto", "medium",  "none")).toBe(false);
    expect(wasExpected("auto", "low",     "none")).toBe(false);
    // "unknown" risk level is treated as high (ordinal 2), so it exceeds low/medium/none thresholds.
    expect(wasExpected("auto", "unknown", "low")).toBe(false);
    expect(wasExpected("auto", "unknown", "none")).toBe(false);
  });

  test("normalizes approvalMode, riskLevel and riskThreshold case (server may return uppercase)", () => {
    // riskLevel / riskThreshold uppercase
    expect(wasExpected("auto", "HIGH",   "low")).toBe(false);
    expect(wasExpected("auto", "HIGH",   "HIGH")).toBe(true);
    expect(wasExpected("auto", "MEDIUM", "LOW")).toBe(false);
    expect(wasExpected("auto", "low",    "NONE")).toBe(false);
    // approvalMode uppercase → should still evaluate the ordinal comparison
    expect(wasExpected("AUTO",   "high", "none")).toBe(false);
    expect(wasExpected("Auto",   "low",  "low")).toBe(true);
    expect(wasExpected("BLOCKED","high", "none")).toBe(true); // non-auto → always expected
  });

  test("normalizes approvalMode case (server may return uppercase)", () => {
    expect(wasExpected("Auto",    "high", "low")).toBe(false);
    expect(wasExpected("AUTO",    "high", "medium")).toBe(false);
    expect(wasExpected("AUTO",    "low",  "low")).toBe(true);
  });

  test("missing fields → treated as expected (backward compat)", () => {
    expect(wasExpected(undefined, "high", "none")).toBe(true);  // no approvalMode
    expect(wasExpected("auto", undefined, "low")).toBe(true);   // no riskLevel → ordinal -1 ≤ 0
    expect(wasExpected("auto", "high", undefined)).toBe(true);  // no threshold → legacy record, expected
    expect(wasExpected("auto", "high", "")).toBe(true);         // empty threshold → legacy record, expected
  });
});

describe("getProvenanceText", () => {
  test("maps known reasons to display text", () => {
    expect(getProvenanceText("trust_rule_allowed")).toBe("· Auto-approved · Trust rule matched");
    expect(getProvenanceText("sandbox_auto_approve")).toBe("· Auto-approved · Sandboxed workspace");
    expect(getProvenanceText("platform_auto_approve")).toBe("· Auto-approved · Platform session");
  });

  test("returns null for expected-outcome reasons", () => {
    expect(getProvenanceText("within_threshold")).toBeNull();
    expect(getProvenanceText("user_approved")).toBeNull();
    expect(getProvenanceText("user_denied")).toBeNull();
    expect(getProvenanceText("timed_out")).toBeNull();
    // blocked mode is always wasExpected()=true, so no_interactive_client provenance is never shown
    expect(getProvenanceText("no_interactive_client")).toBeNull();
  });

  test("returns null for undefined (backward compat)", () => {
    expect(getProvenanceText(undefined)).toBeNull();
  });
});
