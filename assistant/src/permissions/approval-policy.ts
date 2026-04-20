import type { TrustRule } from "./types.js";
import { RiskLevel } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Contextual information that an approval policy uses to reach a decision. */
export interface ApprovalContext {
  riskLevel: RiskLevel;
  toolName: string;
  matchedRule?: TrustRule;
  permissionsMode: "strict" | "workspace";
  isContainerized: boolean;
  isWorkspaceScoped: boolean;
  /** Where the tool originates from — "skill" for skill-provided tools, "builtin" for core tools. */
  toolOrigin?: "skill" | "builtin";
  /** Whether the tool's owning skill is a first-party bundled skill. */
  isSkillBundled?: boolean;
  /** Whether the tool has a manifest override (unregistered skill tool). */
  hasManifestOverride?: boolean;
}

/** The outcome of an approval policy evaluation. */
export interface ApprovalDecision {
  decision: "allow" | "prompt" | "deny";
  reason: string;
}

/** An object that evaluates an approval context and returns a decision. */
export interface ApprovalPolicy {
  evaluate(context: ApprovalContext): ApprovalDecision;
}

// ── Default implementation ───────────────────────────────────────────────────

/**
 * Replicates the exact approval decision logic from `check()` in checker.ts
 * (lines 604-725). Each branch is annotated with the corresponding checker.ts
 * code path so reviewers can verify 1:1 parity.
 *
 * The decision flow:
 *
 * 1. Deny rule → deny
 * 2. Ask rule → prompt
 * 3. Allow rule + non-High → allow
 * 4. Allow rule + High + containerized bash → allow (shouldAutoAllowHighRisk)
 * 5. Allow rule + High + no auto-allow → prompt (fall through)
 * 6. No rule + third-party skill tool → prompt
 * 7. No rule + strict mode → prompt
 * 8. No rule + workspace mode + Low + workspace-scoped → allow
 *    (except non-containerized bash — never auto-allow)
 * 9. No rule + Low + bundled skill → allow
 * 10. High → prompt
 * 11. Low → allow
 * 12. Medium → prompt
 */
export class DefaultApprovalPolicy implements ApprovalPolicy {
  evaluate(context: ApprovalContext): ApprovalDecision {
    const {
      riskLevel,
      toolName,
      matchedRule,
      permissionsMode,
      isContainerized,
      isWorkspaceScoped,
      toolOrigin,
      isSkillBundled,
      hasManifestOverride,
    } = context;

    // ── 1. Deny rules apply at ALL risk levels ────────────────────────
    if (matchedRule && matchedRule.decision === "deny") {
      return {
        decision: "deny",
        reason: `Blocked by deny rule: ${matchedRule.pattern}`,
      };
    }

    // ── 2. Ask rules always prompt ────────────────────────────────────
    if (matchedRule && matchedRule.decision === "ask") {
      return {
        decision: "prompt",
        reason: `Matched ask rule: ${matchedRule.pattern}`,
      };
    }

    // ── 3–5. Allow rule handling ──────────────────────────────────────
    if (matchedRule) {
      // 3. Allow rule + non-High → allow
      if (riskLevel !== RiskLevel.High) {
        return {
          decision: "allow",
          reason: `Matched trust rule: ${matchedRule.pattern}`,
        };
      }

      // 4. Allow rule + High + containerized bash → allow
      if (this.shouldAutoAllowHighRisk(toolName, isContainerized)) {
        return {
          decision: "allow",
          reason: `Matched trust rule in auto-allow-high-risk context: ${matchedRule.pattern}`,
        };
      }

      // 5. Allow rule + High (no auto-allow) → fall through to risk-based
    }

    // ── 6. No rule + third-party skill tool → prompt ──────────────────
    if (!matchedRule) {
      if (toolOrigin === "skill" && !isSkillBundled) {
        return {
          decision: "prompt",
          reason: "Skill tool: requires approval by default",
        };
      }
      if (hasManifestOverride && !toolOrigin) {
        return {
          decision: "prompt",
          reason: "Skill tool: requires approval by default",
        };
      }
    }

    // ── 7. No rule + strict mode → prompt ─────────────────────────────
    if (permissionsMode === "strict" && !matchedRule) {
      return {
        decision: "prompt",
        reason: "Strict mode: no matching rule, requires approval",
      };
    }

    // ── 8. No rule + workspace mode + Low + workspace-scoped → allow ──
    // Exception: non-containerized bash never auto-allows.
    if (
      permissionsMode === "workspace" &&
      !matchedRule &&
      riskLevel === RiskLevel.Low
    ) {
      if (toolName === "bash" && !isContainerized) {
        // Fall through to risk-based policy below
      } else if (isWorkspaceScoped) {
        return {
          decision: "allow",
          reason: "Workspace mode: workspace-scoped operation auto-allowed",
        };
      }
    }

    // ── 9. No rule + Low + bundled skill → allow ──────────────────────
    if (!matchedRule && riskLevel === RiskLevel.Low) {
      if (toolOrigin === "skill" && isSkillBundled) {
        return {
          decision: "allow",
          reason: "Bundled skill tool: low risk, auto-allowed",
        };
      }
    }

    // ── 10–12. Risk-based fallback ────────────────────────────────────
    if (riskLevel === RiskLevel.High) {
      return {
        decision: "prompt",
        reason: "High risk: always requires approval",
      };
    }

    if (riskLevel === RiskLevel.Low) {
      return { decision: "allow", reason: "Low risk: auto-allowed" };
    }

    // Medium (or any unrecognized risk level)
    return {
      decision: "prompt",
      reason: `${riskLevel} risk: requires approval`,
    };
  }

  /**
   * Determines at runtime whether a high-risk operation should be auto-allowed.
   * Mirrors `shouldAutoAllowHighRisk()` in checker.ts.
   *
   * Auto-allow cases:
   * - Containerized bash: all commands are sandboxed, so high-risk is safe.
   */
  private shouldAutoAllowHighRisk(
    toolName: string,
    isContainerized: boolean,
  ): boolean {
    return toolName === "bash" && isContainerized;
  }
}
