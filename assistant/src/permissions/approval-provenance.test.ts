import { describe, expect, test } from "bun:test";

import { mapApprovalProvenance } from "./approval-provenance.js";
import type { ApprovalMode, RiskThreshold } from "./types.js";
import { RISK_ORDINAL, THRESHOLD_ORDINAL } from "./types.js";

// ── mapApprovalProvenance — one test per row of the decision mapping table ────

describe("mapApprovalProvenance", () => {
  test("platform_auto_approve → auto / platform_auto_approve", () => {
    const r = mapApprovalProvenance("platform_auto_approve", {});
    expect(r.approvalMode).toBe("auto");
    expect(r.approvalReason).toBe("platform_auto_approve");
  });

  test("guardian_auto_approve → auto / within_threshold", () => {
    const r = mapApprovalProvenance("guardian_auto_approve", {});
    expect(r.approvalMode).toBe("auto");
    expect(r.approvalReason).toBe("within_threshold");
  });

  test("allow + sandbox → auto / sandbox_auto_approve", () => {
    const r = mapApprovalProvenance("allow", { hasSandboxAutoApprove: true });
    expect(r.approvalMode).toBe("auto");
    expect(r.approvalReason).toBe("sandbox_auto_approve");
  });

  test("allow + trust rule → auto / trust_rule_allowed", () => {
    const r = mapApprovalProvenance("allow", { matchedTrustRuleId: "rule-abc" });
    expect(r.approvalMode).toBe("auto");
    expect(r.approvalReason).toBe("trust_rule_allowed");
  });

  test("allow (no trust rule, no sandbox) → auto / within_threshold", () => {
    const r = mapApprovalProvenance("allow", {});
    expect(r.approvalMode).toBe("auto");
    expect(r.approvalReason).toBe("within_threshold");
  });

  test("allow + wasPrompted → prompted / user_approved", () => {
    const r = mapApprovalProvenance("allow", { wasPrompted: true });
    expect(r.approvalMode).toBe("prompted");
    expect(r.approvalReason).toBe("user_approved");
  });

  test("deny (user pressed deny) → prompted / user_denied", () => {
    const r = mapApprovalProvenance("deny", {});
    expect(r.approvalMode).toBe("prompted");
    expect(r.approvalReason).toBe("user_denied");
  });

  test("denied + matchedTrustRuleId → blocked / trust_rule_denied", () => {
    const r = mapApprovalProvenance("denied", { matchedTrustRuleId: "rule-abc" });
    expect(r.approvalMode).toBe("blocked");
    expect(r.approvalReason).toBe("trust_rule_denied");
  });

  test("denied (no matchedTrustRuleId) → blocked / no_interactive_client", () => {
    const r = mapApprovalProvenance("denied", {});
    expect(r.approvalMode).toBe("blocked");
    expect(r.approvalReason).toBe("no_interactive_client");
  });

  test("unknown decision → unknown / unknown", () => {
    const r = mapApprovalProvenance("something_unexpected", {});
    expect(r.approvalMode).toBe("unknown");
    expect(r.approvalReason).toBe("unknown");
  });

  test("sandbox takes priority over trust rule when both present", () => {
    const r = mapApprovalProvenance("allow", {
      hasSandboxAutoApprove: true,
      matchedTrustRuleId: "rule-xyz",
    });
    expect(r.approvalReason).toBe("sandbox_auto_approve");
  });

  test("wasPrompted takes priority over sandbox when both set", () => {
    const r = mapApprovalProvenance("allow", {
      wasPrompted: true,
      hasSandboxAutoApprove: true,
    });
    expect(r.approvalMode).toBe("prompted");
    expect(r.approvalReason).toBe("user_approved");
  });
});

// ── wasExpected derivation — all combinations ─────────────────────────────────

function wasExpected(
  approvalMode: ApprovalMode,
  riskLevel: string,
  riskThreshold: RiskThreshold,
): boolean {
  if (approvalMode !== "auto") return true;
  return RISK_ORDINAL[riskLevel] <= THRESHOLD_ORDINAL[riskThreshold];
}

describe("wasExpected derivation", () => {
  test("prompted outcomes are always expected", () => {
    expect(wasExpected("prompted", "high", "none")).toBe(true);
    expect(wasExpected("prompted", "high", "low")).toBe(true);
  });

  test("blocked outcomes are always expected", () => {
    expect(wasExpected("blocked", "high", "none")).toBe(true);
    expect(wasExpected("blocked", "medium", "low")).toBe(true);
  });

  test("unknown (legacy) outcomes are always expected", () => {
    expect(wasExpected("unknown", "high", "none")).toBe(true);
  });

  test("auto: risk within threshold → expected", () => {
    expect(wasExpected("auto", "low", "low")).toBe(true);
    expect(wasExpected("auto", "low", "medium")).toBe(true);
    expect(wasExpected("auto", "medium", "medium")).toBe(true);
    expect(wasExpected("auto", "high", "high")).toBe(true);
  });

  test("auto: risk above threshold → unexpected", () => {
    expect(wasExpected("auto", "high", "low")).toBe(false);
    expect(wasExpected("auto", "high", "medium")).toBe(false);
    expect(wasExpected("auto", "medium", "low")).toBe(false);
    expect(wasExpected("auto", "high", "none")).toBe(false);
    expect(wasExpected("auto", "medium", "none")).toBe(false);
    expect(wasExpected("auto", "low", "none")).toBe(false);
  });
});

// ── Invariant: new records must not emit approvalMode: "unknown" ──────────────

describe("approvalMode unknown invariant", () => {
  const knownDecisions = [
    "allow",
    "deny",
    "denied",
    "platform_auto_approve",
    "guardian_auto_approve",
  ];

  test("every known decision produces a non-unknown approvalMode", () => {
    for (const decision of knownDecisions) {
      const r = mapApprovalProvenance(decision, {});
      expect(r.approvalMode).not.toBe("unknown");
    }
  });

  test("only unrecognised decision strings emit unknown", () => {
    const r = mapApprovalProvenance("__legacy_unknown__", {});
    expect(r.approvalMode).toBe("unknown");
  });
});
