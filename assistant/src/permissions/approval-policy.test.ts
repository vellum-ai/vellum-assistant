import { describe, expect, test } from "bun:test";

import type { ApprovalContext, ApprovalDecision } from "./approval-policy.js";
import { DefaultApprovalPolicy } from "./approval-policy.js";
import { RiskLevel } from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const policy = new DefaultApprovalPolicy();

function makeContext(overrides: Partial<ApprovalContext>): ApprovalContext {
  return {
    riskLevel: RiskLevel.Low,
    toolName: "bash",
    isContainerized: false,
    isWorkspaceScoped: false,
    ...overrides,
  };
}

function evaluate(overrides: Partial<ApprovalContext>): ApprovalDecision {
  return policy.evaluate(makeContext(overrides));
}

// ── Sandbox auto-approve ─────────────────────────────────────────────────────

describe("sandbox auto-approve", () => {
  test("bash + hasSandboxAutoApprove + containerized → allow", () => {
    const result = evaluate({
      riskLevel: RiskLevel.High,
      toolName: "bash",
      hasSandboxAutoApprove: true,
      isContainerized: true,
    });
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("sandbox auto-approve");
  });

  test("bash + hasSandboxAutoApprove + not containerized → allow (path resolution is baked in)", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Low,
      toolName: "bash",
      hasSandboxAutoApprove: true,
      isContainerized: false,
    });
    // hasSandboxAutoApprove === true means path resolution already passed upstream.
    // The isContainerized gate was removed — sandbox auto-approve fires regardless.
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("sandbox auto-approve");
  });

  test("bash + hasSandboxAutoApprove + not containerized + High risk → allow (path resolution validated upstream)", () => {
    const result = evaluate({
      riskLevel: RiskLevel.High,
      toolName: "bash",
      hasSandboxAutoApprove: true,
      isContainerized: false,
    });
    // Even at High risk, hasSandboxAutoApprove === true means the checker already
    // validated that all path arguments are within the workspace root.
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("sandbox auto-approve");
  });

  test("host_bash + hasSandboxAutoApprove + containerized → falls through", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Low,
      toolName: "host_bash",
      hasSandboxAutoApprove: true,
      isContainerized: true,
    });
    // host_bash is not "bash", so sandbox auto-approve doesn't fire.
    // Falls through to risk-based: Low → allow (within default "low" threshold)
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("within auto-approve threshold");
  });

  test("bash + no hasSandboxAutoApprove + containerized → falls through", () => {
    const result = evaluate({
      riskLevel: RiskLevel.High,
      toolName: "bash",
      hasSandboxAutoApprove: false,
      isContainerized: true,
    });
    // hasSandboxAutoApprove is false, so sandbox auto-approve doesn't fire.
    // Falls through to risk-based: High → prompt
    expect(result.decision).toBe("prompt");
    expect(result.reason).toContain("high risk");
  });

  test("sandbox auto-approve fires for High risk commands when threshold allows", () => {
    // e.g. rm -rf in a container where the user has set autoApproveUpTo: "high"
    const result = evaluate({
      riskLevel: RiskLevel.High,
      toolName: "bash",
      hasSandboxAutoApprove: true,
      isContainerized: true,
      autoApproveUpTo: "high",
    });
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("sandbox auto-approve");
  });

  test("sandbox auto-approve blocked when autoApproveUpTo is 'none' (Strict mode override)", () => {
    // Per-conversation Strict override: threshold = none → no commands auto-approved.
    const result = evaluate({
      riskLevel: RiskLevel.Low,
      toolName: "bash",
      hasSandboxAutoApprove: true,
      isContainerized: true,
      autoApproveUpTo: "none",
    });
    expect(result.decision).toBe("prompt");
  });

  test("sandbox auto-approve still works when autoApproveUpTo is 'low'", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Low,
      toolName: "bash",
      hasSandboxAutoApprove: true,
      isContainerized: true,
      autoApproveUpTo: "low",
    });
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("sandbox auto-approve");
  });

  test("autoApproveUpTo 'none' blocks sandbox auto-approve", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Low,
      toolName: "bash",
      hasSandboxAutoApprove: true,
      isContainerized: true,
      autoApproveUpTo: "none",
    });
    expect(result.decision).toBe("prompt");
    expect(result.reason).toContain("above auto-approve threshold");
  });
});

// ── No rule: third-party skill tool ──────────────────────────────────────────

describe("no rule — third-party skill tool", () => {
  test("skill origin, not bundled, strict threshold → prompt", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Low,
      toolName: "custom_tool",
      toolOrigin: "skill",
      isSkillBundled: false,
      autoApproveUpTo: "none",
    });
    expect(result.decision).toBe("prompt");
    expect(result.reason).toContain("Skill tool");
  });

  test("skill origin, not bundled, Medium risk → prompt (above default threshold)", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Medium,
      toolName: "custom_tool",
      toolOrigin: "skill",
      isSkillBundled: false,
    });
    expect(result.decision).toBe("prompt");
    expect(result.reason).toContain("Skill tool");
  });

  test("plugin origin → treated as extension-owned (prompt at strict threshold)", () => {
    // Plugins join skills in the "extension-owned" bucket — both prompt by
    // default. `isSkillBundled` is irrelevant for plugins (always false).
    const result = evaluate({
      riskLevel: RiskLevel.Low,
      toolName: "custom_plugin_tool",
      toolOrigin: "plugin",
      autoApproveUpTo: "none",
    });
    expect(result.decision).toBe("prompt");
    expect(result.reason).toContain("Skill tool");
  });

  test("no tool origin but hasManifestOverride, strict threshold → prompt (unregistered skill tool)", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Low,
      toolName: "unknown_tool",
      hasManifestOverride: true,
      autoApproveUpTo: "none",
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

  test("skill origin, not bundled, threshold covers risk → allow", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Low,
      toolName: "custom_tool",
      toolOrigin: "skill",
      isSkillBundled: false,
      autoApproveUpTo: "medium",
    });
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("within auto-approve threshold");
  });

  test("skill origin, not bundled, threshold does not cover risk → prompt", () => {
    const result = evaluate({
      riskLevel: RiskLevel.High,
      toolName: "custom_tool",
      toolOrigin: "skill",
      isSkillBundled: false,
      autoApproveUpTo: "medium",
    });
    expect(result.decision).toBe("prompt");
    expect(result.reason).toContain("Skill tool");
  });

  test("hasManifestOverride, threshold covers risk → allow", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Low,
      toolName: "unknown_tool",
      hasManifestOverride: true,
      autoApproveUpTo: "low",
    });
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("within auto-approve threshold");
  });
});

// ── No rule: autoApproveUpTo "none" (strict-equivalent) ────────────────────

describe("no rule — autoApproveUpTo 'none'", () => {
  test("none threshold, Low risk, not workspace-scoped → prompt", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Low,
      toolName: "file_read",
      autoApproveUpTo: "none",
    });
    expect(result.decision).toBe("prompt");
    expect(result.reason).toContain("above auto-approve threshold");
  });

  test("none threshold, Medium risk → prompt", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Medium,
      toolName: "file_read",
      autoApproveUpTo: "none",
    });
    expect(result.decision).toBe("prompt");
    expect(result.reason).toContain("above auto-approve threshold");
  });

  test("none threshold, High risk → prompt", () => {
    const result = evaluate({
      riskLevel: RiskLevel.High,
      toolName: "file_read",
      autoApproveUpTo: "none",
    });
    expect(result.decision).toBe("prompt");
    expect(result.reason).toContain("above auto-approve threshold");
  });

  test("none threshold, Low risk, workspace-scoped → prompt (threshold respected)", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Low,
      toolName: "file_read",
      autoApproveUpTo: "none",
      isWorkspaceScoped: true,
    });
    expect(result.decision).toBe("prompt");
    expect(result.reason).toContain("above auto-approve threshold");
  });

  test("none threshold with low autoApproveUpTo → allow", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Low,
      toolName: "file_read",
      autoApproveUpTo: "low",
    });
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("within auto-approve threshold");
  });

  test("medium risk with low threshold → prompt", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Medium,
      toolName: "file_read",
      autoApproveUpTo: "low",
    });
    expect(result.decision).toBe("prompt");
    expect(result.reason).toContain("above auto-approve threshold");
  });
});

// ── No rule: workspace-scoped operations ──────────────────────────────────────

describe("no rule — workspace-scoped operations", () => {
  test("Low risk, workspace-scoped, within threshold → allow", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Low,
      toolName: "file_read",
      isWorkspaceScoped: true,
    });
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("Workspace-scoped");
  });

  test("Low risk, NOT workspace-scoped → falls through to threshold allow", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Low,
      toolName: "file_read",
      isWorkspaceScoped: false,
    });
    // Falls through to risk-based: Low → allow (within default "low" threshold)
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("low risk");
  });

  test("Medium risk, workspace-scoped → falls through to risk-based prompt", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Medium,
      toolName: "file_write",
      isWorkspaceScoped: true,
    });
    expect(result.decision).toBe("prompt");
    expect(result.reason).toContain("medium risk");
  });

  test("bash, NOT containerized, Low risk, workspace-scoped → allow via workspace-scoped check", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Low,
      toolName: "bash",
      isContainerized: false,
      isWorkspaceScoped: true,
    });
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("Workspace-scoped");
  });

  test("bash, containerized, Low risk, workspace-scoped → allow via workspace-scoped check", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Low,
      toolName: "bash",
      isContainerized: true,
      isWorkspaceScoped: true,
    });
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("Workspace-scoped");
  });

  test("Low risk, workspace-scoped, autoApproveUpTo 'none' → prompt (threshold not met)", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Low,
      toolName: "file_read",
      isWorkspaceScoped: true,
      autoApproveUpTo: "none",
    });
    expect(result.decision).toBe("prompt");
    expect(result.reason).toContain("above auto-approve threshold");
  });
});

// ── No rule: bundled skill tool ──────────────────────────────────────────────

describe("no rule — bundled skill tool", () => {
  test("bundled skill, Low risk → allow", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Low,
      toolName: "bundled_tool",
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
      toolOrigin: "skill",
      isSkillBundled: true,
    });
    expect(result.decision).toBe("prompt");
    expect(result.reason).toContain("high risk");
  });

  test("bundled skill, Low risk, autoApproveUpTo 'none' → prompt (threshold respected)", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Low,
      toolName: "bundled_tool",
      toolOrigin: "skill",
      isSkillBundled: true,
      autoApproveUpTo: "none",
    });
    expect(result.decision).toBe("prompt");
    expect(result.reason).toContain("above auto-approve threshold");
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
  test("non-containerized bash, Low risk, workspace-scoped → workspace-scoped allow", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Low,
      toolName: "bash",
      isContainerized: false,
      isWorkspaceScoped: true,
    });
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("Workspace-scoped");
  });

  test("hasManifestOverride with toolOrigin set to skill — third-party check triggers on origin", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Low,
      toolName: "manifest_tool",
      toolOrigin: "skill",
      isSkillBundled: false,
      hasManifestOverride: true,
      autoApproveUpTo: "none",
    });
    expect(result.decision).toBe("prompt");
    expect(result.reason).toContain("Skill tool");
  });

  test("hasManifestOverride with toolOrigin=mcp — falls through (not extension-owned)", () => {
    const result = evaluate({
      riskLevel: RiskLevel.Low,
      toolName: "manifest_tool",
      toolOrigin: "mcp",
      hasManifestOverride: true,
    });
    // toolOrigin is "mcp", which is not extension-class (skill/plugin), so
    // the third-party skill check doesn't trigger. The hasManifestOverride
    // sub-check requires !toolOrigin, but toolOrigin is set. Falls through
    // to risk-based: Low → allow (within default "low" threshold).
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

  describe('autoApproveUpTo: "high" — everything auto-allows', () => {
    test("Low risk → allow", () => {
      const result = evaluate({
        riskLevel: RiskLevel.Low,
        toolName: "some_tool",
        autoApproveUpTo: "high",
      });
      expect(result.decision).toBe("allow");
      expect(result.reason).toContain("within auto-approve threshold");
    });

    test("Medium risk → allow", () => {
      const result = evaluate({
        riskLevel: RiskLevel.Medium,
        toolName: "some_tool",
        autoApproveUpTo: "high",
      });
      expect(result.decision).toBe("allow");
      expect(result.reason).toContain("within auto-approve threshold");
    });

    test("High risk → allow", () => {
      const result = evaluate({
        riskLevel: RiskLevel.High,
        toolName: "some_tool",
        autoApproveUpTo: "high",
      });
      expect(result.decision).toBe("allow");
      expect(result.reason).toContain("within auto-approve threshold");
    });
  });

  describe("threshold controls workspace-scoped operations", () => {
    test("workspace-scoped Low with 'medium' threshold → allow via workspace-scoped path", () => {
      const result = evaluate({
        riskLevel: RiskLevel.Low,
        toolName: "file_read",
        isWorkspaceScoped: true,
        autoApproveUpTo: "medium",
      });
      expect(result.decision).toBe("allow");
      expect(result.reason).toContain("Workspace-scoped");
    });

    test("workspace-scoped Low with 'none' threshold → prompt (threshold gates workspace-scoped too)", () => {
      const result = evaluate({
        riskLevel: RiskLevel.Low,
        toolName: "file_read",
        isWorkspaceScoped: true,
        autoApproveUpTo: "none",
      });
      expect(result.decision).toBe("prompt");
      expect(result.reason).toContain("above auto-approve threshold");
    });

    test("non-workspace-scoped Low with 'none' threshold → prompt", () => {
      const result = evaluate({
        riskLevel: RiskLevel.Low,
        toolName: "file_read",
        isWorkspaceScoped: false,
        autoApproveUpTo: "none",
      });
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
