import { describe, expect, test } from "bun:test";
import { getEffectiveRiskDisplay, getProvenanceText, getRiskBadgeStyle, wasExpected } from "@/domains/chat/utils/risk";

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
    expect(getProvenanceText("platform_auto_approve")).toBe("· Auto-approved · Platform session");
  });

  test("sandbox_auto_approve returns null (chip replaces provenance text)", () => {
    expect(getProvenanceText("sandbox_auto_approve")).toBeNull();
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

describe("getRiskBadgeStyle", () => {
  test("workspace returns slate/outlined styling", () => {
    const style = getRiskBadgeStyle("workspace");
    expect(style.bg).toBe("bg-[var(--surface-lift)]");
    expect(style.text).toBe("text-[var(--content-secondary)]");
    expect(style.border).toBe("border border-[var(--border-element)]");
    expect(style.label).toBe("Workspace");
  });

  test("existing risk levels do not have a border field", () => {
    expect(getRiskBadgeStyle("low").border).toBeUndefined();
    expect(getRiskBadgeStyle("medium").border).toBeUndefined();
    expect(getRiskBadgeStyle("high").border).toBeUndefined();
  });
});

describe("getEffectiveRiskDisplay", () => {
  test("sandbox_auto_approve maps to workspace with inherent risk preserved", () => {
    expect(getEffectiveRiskDisplay("sandbox_auto_approve", "high")).toEqual({
      displayLevel: "workspace",
      inherentRisk: "high",
    });
    expect(getEffectiveRiskDisplay("sandbox_auto_approve", "medium")).toEqual({
      displayLevel: "workspace",
      inherentRisk: "medium",
    });
    expect(getEffectiveRiskDisplay("sandbox_auto_approve", "low")).toEqual({
      displayLevel: "workspace",
      inherentRisk: "low",
    });
  });

  test("non-sandbox reasons pass through the risk level", () => {
    expect(getEffectiveRiskDisplay("trust_rule_allowed", "high")).toEqual({
      displayLevel: "high",
    });
    expect(getEffectiveRiskDisplay("trust_rule_allowed", "medium")).toEqual({
      displayLevel: "medium",
    });
    expect(getEffectiveRiskDisplay("platform_auto_approve", "high")).toEqual({
      displayLevel: "high",
    });
  });

  test("undefined approvalReason passes through the risk level", () => {
    expect(getEffectiveRiskDisplay(undefined, "low")).toEqual({
      displayLevel: "low",
    });
    expect(getEffectiveRiskDisplay(undefined, "medium")).toEqual({
      displayLevel: "medium",
    });
  });

  test("undefined riskLevel defaults to unknown", () => {
    expect(getEffectiveRiskDisplay(undefined, undefined)).toEqual({
      displayLevel: "unknown",
    });
  });
});
