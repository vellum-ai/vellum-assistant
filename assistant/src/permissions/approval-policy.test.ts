import { describe, expect, test } from "bun:test";

import type { ApprovalContext, ApprovalDecision } from "./approval-policy.js";
import { DefaultApprovalPolicy, resolveThreshold } from "./approval-policy.js";
import type { TrustRule } from "./types.js";
import { RiskLevel } from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const policy = new DefaultApprovalPolicy();

function makeRule(
  overrides: Partial<TrustRule> & { decision: TrustRule["decision"] },
): TrustRule {
  return {
    id: "test-rule",
    tool: "bash",
    pattern: "test-pattern",
    priority: 100,
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeContext(overrides: Partial<ApprovalContext>): ApprovalContext {
  return {
    riskLevel: RiskLevel.Low,
    toolName: "bash",
    permissionsMode: "workspace",
    isContainerized: false,
    isWorkspaceScoped: false,
    ...overrides,
  };
}

function evaluate(overrides: Partial<ApprovalContext>): ApprovalDecision {
  return policy.evaluate(makeContext(overrides));
}

// ── Deny rule at each risk level ─────────────────────────────────────────────

describe("deny rule", () => {
  const denyRule = makeRule({ decision: "deny" });

  test("deny at Low risk", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Low,
      matchedRule: denyRule,
    });
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("deny rule");
    expect(result.matchedRule).toBe(denyRule);
  });

  test("deny at Medium risk", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Medium,
      matchedRule: denyRule,
    });
    expect(result.decision).toBe("deny");
  });

  test("deny at High risk", () => {
    const result = evaluate({
      riskLevel: RiskLevel.High,
      matchedRule: denyRule,
    });
    expect(result.decision).toBe("deny");
  });
});

// ── Ask rule at each risk level ──────────────────────────────────────────────

describe("ask rule", () => {
  const askRule = makeRule({ decision: "ask" });

  test("ask at Low risk", () => {
    const result = evaluate({ riskLevel: RiskLevel.Low, matchedRule: askRule });
    expect(result.decision).toBe("prompt");
    expect(result.reason).toContain("ask rule");
    expect(result.matchedRule).toBe(askRule);
  });

  test("ask at Medium risk", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Medium,
      matchedRule: askRule,
    });
    expect(result.decision).toBe("prompt");
  });

  test("ask at High risk", () => {
    const result = evaluate({
      riskLevel: RiskLevel.High,
      matchedRule: askRule,
    });
    expect(result.decision).toBe("prompt");
  });
});

// ── Allow rule at each risk level ────────────────────────────────────────────

describe("allow rule", () => {
  const allowRule = makeRule({ decision: "allow" });

  test("allow at Low risk", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Low,
      matchedRule: allowRule,
    });
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("Matched trust rule");
    expect(result.matchedRule).toBe(allowRule);
  });

  test("allow at Medium risk", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Medium,
      matchedRule: allowRule,
    });
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("Matched trust rule");
    expect(result.matchedRule).toBe(allowRule);
  });

  test("allow at High risk — non-containerized bash → prompt, no matchedRule in decision", () => {
    const result = evaluate({
      riskLevel: RiskLevel.High,
      toolName: "bash",
      matchedRule: allowRule,
      isContainerized: false,
    });
    expect(result.decision).toBe("prompt");
    expect(result.reason).toContain("high risk");
    // Decision is driven by risk-based fallback, not the rule
    expect(result.matchedRule).toBeUndefined();
  });

  test("allow at High risk — containerized bash → allow (auto-allow), matchedRule present", () => {
    const result = evaluate({
      riskLevel: RiskLevel.High,
      toolName: "bash",
      matchedRule: allowRule,
      isContainerized: true,
    });
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("auto-allow-high-risk");
    expect(result.matchedRule).toBe(allowRule);
  });

  test("allow at High risk — non-bash tool, containerized → prompt, no matchedRule in decision", () => {
    const result = evaluate({
      riskLevel: RiskLevel.High,
      toolName: "file_write",
      matchedRule: allowRule,
      isContainerized: true,
    });
    expect(result.decision).toBe("prompt");
    expect(result.reason).toContain("high risk");
    // Decision is driven by risk-based fallback, not the rule
    expect(result.matchedRule).toBeUndefined();
  });

  test("allow at High risk — non-bash tool, non-containerized → prompt, no matchedRule in decision", () => {
    const result = evaluate({
      riskLevel: RiskLevel.High,
      toolName: "file_write",
      matchedRule: allowRule,
      isContainerized: false,
    });
    expect(result.decision).toBe("prompt");
    expect(result.reason).toContain("high risk");
    // Decision is driven by risk-based fallback, not the rule
    expect(result.matchedRule).toBeUndefined();
  });
});

// ── No rule: third-party skill tool ──────────────────────────────────────────

describe("no rule — third-party skill tool", () => {
  test("skill origin, not bundled → prompt", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Low,
      toolName: "custom_tool",
      toolOrigin: "skill",
      isSkillBundled: false,
    });
    expect(result.decision).toBe("prompt");
    expect(result.reason).toContain("Skill tool");
  });

  test("skill origin, not bundled, Medium risk → prompt", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Medium,
      toolName: "custom_tool",
      toolOrigin: "skill",
      isSkillBundled: false,
    });
    expect(result.decision).toBe("prompt");
    expect(result.reason).toContain("Skill tool");
  });

  test("no tool origin but hasManifestOverride → prompt (unregistered skill tool)", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Low,
      toolName: "unknown_tool",
      hasManifestOverride: true,
    });
    expect(result.decision).toBe("prompt");
    expect(result.reason).toContain("Skill tool");
  });

  test("skill origin, bundled → falls through (not third-party)", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Low,
      toolName: "bundled_tool",
      toolOrigin: "skill",
      isSkillBundled: true,
    });
    // Bundled skill + Low risk + no rule → handled by step 9 or 11
    expect(result.decision).toBe("allow");
  });
});

// ── No rule: strict mode ─────────────────────────────────────────────────────

describe("no rule — strict mode", () => {
  test("strict mode, Low risk → prompt", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Low,
      toolName: "file_read",
      permissionsMode: "strict",
    });
    expect(result.decision).toBe("prompt");
    expect(result.reason).toContain("Strict mode");
  });

  test("strict mode, Medium risk → prompt", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Medium,
      toolName: "file_read",
      permissionsMode: "strict",
    });
    expect(result.decision).toBe("prompt");
    expect(result.reason).toContain("Strict mode");
  });

  test("strict mode, High risk → prompt", () => {
    const result = evaluate({
      riskLevel: RiskLevel.High,
      toolName: "file_read",
      permissionsMode: "strict",
    });
    expect(result.decision).toBe("prompt");
    expect(result.reason).toContain("Strict mode");
  });

  test("strict mode blocks bundled skill tools without explicit rule", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Low,
      toolName: "bundled_tool",
      permissionsMode: "strict",
      toolOrigin: "skill",
      isSkillBundled: true,
    });
    expect(result.decision).toBe("prompt");
    expect(result.reason).toContain("Strict mode");
  });
});

// ── No rule: workspace mode ──────────────────────────────────────────────────

describe("no rule — workspace mode", () => {
  test("workspace mode, Low risk, workspace-scoped → allow", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Low,
      toolName: "file_read",
      permissionsMode: "workspace",
      isWorkspaceScoped: true,
    });
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("Workspace mode");
  });

  test("workspace mode, Low risk, NOT workspace-scoped → falls through", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Low,
      toolName: "file_read",
      permissionsMode: "workspace",
      isWorkspaceScoped: false,
    });
    // Falls through to risk-based: Low → allow (within default "low" threshold)
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("low risk");
  });

  test("workspace mode, Medium risk → falls through to risk-based prompt", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Medium,
      toolName: "file_write",
      permissionsMode: "workspace",
      isWorkspaceScoped: true,
    });
    expect(result.decision).toBe("prompt");
    expect(result.reason).toContain("medium risk");
  });

  test("workspace mode, bash, NOT containerized, Low risk, workspace-scoped → falls through (no auto-allow for host bash)", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Low,
      toolName: "bash",
      permissionsMode: "workspace",
      isContainerized: false,
      isWorkspaceScoped: true,
    });
    // Non-containerized bash falls through the workspace check.
    // Then hits risk-based: Low → allow (within default "low" threshold)
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("low risk");
  });

  test("workspace mode, bash, containerized, Low risk, workspace-scoped → allow via workspace mode", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Low,
      toolName: "bash",
      permissionsMode: "workspace",
      isContainerized: true,
      isWorkspaceScoped: true,
    });
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("Workspace mode");
  });
});

// ── No rule: bundled skill tool ──────────────────────────────────────────────

describe("no rule — bundled skill tool", () => {
  test("bundled skill, Low risk → allow", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Low,
      toolName: "bundled_tool",
      permissionsMode: "workspace",
      toolOrigin: "skill",
      isSkillBundled: true,
    });
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("Bundled skill");
  });

  test("bundled skill, Medium risk → prompt (only Low auto-allows)", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Medium,
      toolName: "bundled_tool",
      permissionsMode: "workspace",
      toolOrigin: "skill",
      isSkillBundled: true,
    });
    expect(result.decision).toBe("prompt");
    expect(result.reason).toContain("medium risk");
  });

  test("bundled skill, High risk → prompt", () => {
    const result = evaluate({
      riskLevel: RiskLevel.High,
      toolName: "bundled_tool",
      permissionsMode: "workspace",
      toolOrigin: "skill",
      isSkillBundled: true,
    });
    expect(result.decision).toBe("prompt");
    expect(result.reason).toContain("high risk");
  });
});

// ── Risk-based fallback ──────────────────────────────────────────────────────

describe("risk-based fallback (no rule, no special case)", () => {
  test("High risk → prompt", () => {
    const result = evaluate({
      riskLevel: RiskLevel.High,
      toolName: "some_tool",
    });
    expect(result.decision).toBe("prompt");
    expect(result.reason).toContain("high risk");
  });

  test("Low risk → allow", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Low,
      toolName: "some_tool",
    });
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("low risk");
  });

  test("Medium risk → prompt", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Medium,
      toolName: "some_tool",
    });
    expect(result.decision).toBe("prompt");
    expect(result.reason).toContain("medium risk");
  });
});

// ── Edge cases and combined scenarios ────────────────────────────────────────

describe("edge cases", () => {
  test("deny rule takes precedence over allow-everything else", () => {
    const denyRule = makeRule({ decision: "deny" });
    const result = evaluate({
      riskLevel: RiskLevel.Low,
      toolName: "bash",
      matchedRule: denyRule,
      isContainerized: true,
      isWorkspaceScoped: true,
      permissionsMode: "workspace",
    });
    expect(result.decision).toBe("deny");
  });

  test("ask rule takes precedence over allow-for-low", () => {
    const askRule = makeRule({ decision: "ask" });
    const result = evaluate({
      riskLevel: RiskLevel.Low,
      toolName: "bash",
      matchedRule: askRule,
      isContainerized: true,
    });
    expect(result.decision).toBe("prompt");
  });

  test("allow rule High risk falls through to prompt even with workspace mode", () => {
    const allowRule = makeRule({ decision: "allow" });
    const result = evaluate({
      riskLevel: RiskLevel.High,
      toolName: "file_write",
      matchedRule: allowRule,
      permissionsMode: "workspace",
      isContainerized: false,
      isWorkspaceScoped: true,
    });
    // Allow rule + High risk + non-bash → falls through to risk-based: High → prompt
    expect(result.decision).toBe("prompt");
    expect(result.reason).toContain("high risk");
  });

  test("reason includes the matched rule pattern", () => {
    const rule = makeRule({ decision: "allow", pattern: "git status" });
    const result = evaluate({
      riskLevel: RiskLevel.Low,
      matchedRule: rule,
    });
    expect(result.reason).toContain("git status");
  });

  test("deny reason includes the matched rule pattern", () => {
    const rule = makeRule({ decision: "deny", pattern: "rm -rf /" });
    const result = evaluate({
      riskLevel: RiskLevel.Low,
      matchedRule: rule,
    });
    expect(result.reason).toContain("rm -rf /");
  });

  test("strict mode with matched allow rule at Low risk → allow (rule takes precedence)", () => {
    const allowRule = makeRule({ decision: "allow" });
    const result = evaluate({
      riskLevel: RiskLevel.Low,
      toolName: "file_read",
      matchedRule: allowRule,
      permissionsMode: "strict",
    });
    expect(result.decision).toBe("allow");
  });

  test("workspace mode non-containerized bash, Low risk, workspace-scoped → low risk allow (not workspace allow)", () => {
    // This is the subtle bash host exception. The workspace mode check
    // specifically skips bash when not containerized, so it falls through
    // to the risk-based path where Low risk still auto-allows.
    const result = evaluate({
      riskLevel: RiskLevel.Low,
      toolName: "bash",
      permissionsMode: "workspace",
      isContainerized: false,
      isWorkspaceScoped: true,
    });
    expect(result.decision).toBe("allow");
    // The reason should be "low risk" not "Workspace mode" — the workspace
    // auto-allow was bypassed because bash is on the host.
    expect(result.reason).not.toContain("Workspace mode");
    expect(result.reason).toContain("low risk");
  });

  test("hasManifestOverride with toolOrigin set to skill — third-party check triggers on origin", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Low,
      toolName: "manifest_tool",
      toolOrigin: "skill",
      isSkillBundled: false,
      hasManifestOverride: true,
    });
    expect(result.decision).toBe("prompt");
    expect(result.reason).toContain("Skill tool");
  });

  test("hasManifestOverride with toolOrigin set to builtin — falls through (not a skill)", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Low,
      toolName: "manifest_tool",
      toolOrigin: "builtin",
      hasManifestOverride: true,
    });
    // toolOrigin is "builtin", so the third-party skill check doesn't trigger.
    // The hasManifestOverride check requires !toolOrigin, but toolOrigin is set.
    // Falls through to risk-based: Low → allow (within default "low" threshold).
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("low risk");
  });
});

// ── autoApproveUpTo threshold ─────────────────────────────────────────────────

describe("autoApproveUpTo threshold", () => {
  describe('autoApproveUpTo: "none" — everything prompts', () => {
    test("Low risk → prompt", () => {
      const result = evaluate({
        riskLevel: RiskLevel.Low,
        toolName: "some_tool",
        autoApproveUpTo: "none",
      });
      expect(result.decision).toBe("prompt");
      expect(result.reason).toContain("above auto-approve threshold");
    });

    test("Medium risk → prompt", () => {
      const result = evaluate({
        riskLevel: RiskLevel.Medium,
        toolName: "some_tool",
        autoApproveUpTo: "none",
      });
      expect(result.decision).toBe("prompt");
      expect(result.reason).toContain("above auto-approve threshold");
    });

    test("High risk → prompt", () => {
      const result = evaluate({
        riskLevel: RiskLevel.High,
        toolName: "some_tool",
        autoApproveUpTo: "none",
      });
      expect(result.decision).toBe("prompt");
      expect(result.reason).toContain("above auto-approve threshold");
    });
  });

  describe('autoApproveUpTo: "low" — default, matches existing behavior', () => {
    test("Low risk → allow", () => {
      const result = evaluate({
        riskLevel: RiskLevel.Low,
        toolName: "some_tool",
        autoApproveUpTo: "low",
      });
      expect(result.decision).toBe("allow");
      expect(result.reason).toContain("within auto-approve threshold");
    });

    test("Medium risk → prompt", () => {
      const result = evaluate({
        riskLevel: RiskLevel.Medium,
        toolName: "some_tool",
        autoApproveUpTo: "low",
      });
      expect(result.decision).toBe("prompt");
      expect(result.reason).toContain("above auto-approve threshold");
    });

    test("High risk → prompt", () => {
      const result = evaluate({
        riskLevel: RiskLevel.High,
        toolName: "some_tool",
        autoApproveUpTo: "low",
      });
      expect(result.decision).toBe("prompt");
      expect(result.reason).toContain("above auto-approve threshold");
    });
  });

  describe('autoApproveUpTo: "medium" — Low and Medium auto-allow', () => {
    test("Low risk → allow", () => {
      const result = evaluate({
        riskLevel: RiskLevel.Low,
        toolName: "some_tool",
        autoApproveUpTo: "medium",
      });
      expect(result.decision).toBe("allow");
      expect(result.reason).toContain("within auto-approve threshold");
    });

    test("Medium risk → allow", () => {
      const result = evaluate({
        riskLevel: RiskLevel.Medium,
        toolName: "some_tool",
        autoApproveUpTo: "medium",
      });
      expect(result.decision).toBe("allow");
      expect(result.reason).toContain("within auto-approve threshold");
    });

    test("High risk → prompt", () => {
      const result = evaluate({
        riskLevel: RiskLevel.High,
        toolName: "some_tool",
        autoApproveUpTo: "medium",
      });
      expect(result.decision).toBe("prompt");
      expect(result.reason).toContain("above auto-approve threshold");
    });
  });

  describe("threshold interacts correctly with rule-based decisions", () => {
    test("deny rule still denies regardless of threshold", () => {
      const denyRule = makeRule({ decision: "deny" });
      const result = evaluate({
        riskLevel: RiskLevel.Low,
        toolName: "bash",
        matchedRule: denyRule,
        autoApproveUpTo: "medium",
      });
      expect(result.decision).toBe("deny");
      expect(result.matchedRule).toBe(denyRule);
    });

    test("ask rule still prompts regardless of threshold", () => {
      const askRule = makeRule({ decision: "ask" });
      const result = evaluate({
        riskLevel: RiskLevel.Low,
        toolName: "bash",
        matchedRule: askRule,
        autoApproveUpTo: "medium",
      });
      expect(result.decision).toBe("prompt");
      expect(result.matchedRule).toBe(askRule);
    });

    test("allow rule still allows non-High regardless of threshold", () => {
      const allowRule = makeRule({ decision: "allow" });
      const result = evaluate({
        riskLevel: RiskLevel.Medium,
        toolName: "file_write",
        matchedRule: allowRule,
        autoApproveUpTo: "none",
      });
      expect(result.decision).toBe("allow");
      expect(result.matchedRule).toBe(allowRule);
    });
  });

  describe("threshold interacts correctly with strict mode", () => {
    test("strict mode still prompts even with medium threshold", () => {
      const result = evaluate({
        riskLevel: RiskLevel.Low,
        toolName: "file_read",
        permissionsMode: "strict",
        autoApproveUpTo: "medium",
      });
      expect(result.decision).toBe("prompt");
      expect(result.reason).toContain("Strict mode");
    });
  });

  describe("threshold interacts correctly with workspace mode", () => {
    test("workspace mode workspace-scoped Low still allows via workspace path (before threshold)", () => {
      const result = evaluate({
        riskLevel: RiskLevel.Low,
        toolName: "file_read",
        permissionsMode: "workspace",
        isWorkspaceScoped: true,
        autoApproveUpTo: "none",
      });
      // Workspace mode auto-allow fires before the threshold fallback
      expect(result.decision).toBe("allow");
      expect(result.reason).toContain("Workspace mode");
    });

    test("workspace mode non-workspace-scoped Low with none threshold → prompt", () => {
      const result = evaluate({
        riskLevel: RiskLevel.Low,
        toolName: "file_read",
        permissionsMode: "workspace",
        isWorkspaceScoped: false,
        autoApproveUpTo: "none",
      });
      // Falls through workspace check (not workspace-scoped), then threshold
      // "none" means Low risk is above threshold → prompt
      expect(result.decision).toBe("prompt");
      expect(result.reason).toContain("above auto-approve threshold");
    });
  });

  describe("threshold defaults to low when omitted", () => {
    test("omitted autoApproveUpTo behaves as low", () => {
      const result = evaluate({
        riskLevel: RiskLevel.Low,
        toolName: "some_tool",
        // autoApproveUpTo not set
      });
      expect(result.decision).toBe("allow");
      expect(result.reason).toContain("within auto-approve threshold");
    });
  });
});

// ── resolveThreshold ─────────────────────────────────────────────────────────

describe("resolveThreshold", () => {
  describe("scalar form", () => {
    test("returns scalar for conversation context", () => {
      expect(resolveThreshold("low", "conversation")).toBe("low");
    });

    test("returns scalar for background context", () => {
      expect(resolveThreshold("medium", "background")).toBe("medium");
    });

    test("returns scalar for headless context", () => {
      expect(resolveThreshold("none", "headless")).toBe("none");
    });

    test("returns scalar when executionContext is omitted", () => {
      expect(resolveThreshold("low")).toBe("low");
    });
  });

  describe("object form", () => {
    const perContext = {
      conversation: "low" as const,
      background: "medium" as const,
      headless: "none" as const,
    };

    test("returns conversation threshold for conversation context", () => {
      expect(resolveThreshold(perContext, "conversation")).toBe("low");
    });

    test("returns background threshold for background context", () => {
      expect(resolveThreshold(perContext, "background")).toBe("medium");
    });

    test("returns headless threshold for headless context", () => {
      expect(resolveThreshold(perContext, "headless")).toBe("none");
    });

    test("defaults to conversation when executionContext is omitted", () => {
      expect(resolveThreshold(perContext)).toBe("low");
    });
  });

  describe("per-context thresholds in policy evaluation", () => {
    test("conversation context with low threshold prompts medium risk", () => {
      const result = evaluate({
        riskLevel: RiskLevel.Medium,
        toolName: "some_tool",
        autoApproveUpTo: "low",
      });
      expect(result.decision).toBe("prompt");
    });

    test("background context with medium threshold allows medium risk", () => {
      const result = evaluate({
        riskLevel: RiskLevel.Medium,
        toolName: "some_tool",
        autoApproveUpTo: "medium",
      });
      expect(result.decision).toBe("allow");
      expect(result.reason).toContain("within auto-approve threshold");
    });

    test("headless context with none threshold prompts low risk", () => {
      const result = evaluate({
        riskLevel: RiskLevel.Low,
        toolName: "some_tool",
        autoApproveUpTo: "none",
      });
      expect(result.decision).toBe("prompt");
      expect(result.reason).toContain("above auto-approve threshold");
    });

    test("background context with medium threshold prompts high risk", () => {
      const result = evaluate({
        riskLevel: RiskLevel.High,
        toolName: "some_tool",
        autoApproveUpTo: "medium",
      });
      expect(result.decision).toBe("prompt");
      expect(result.reason).toContain("above auto-approve threshold");
    });
  });
});
