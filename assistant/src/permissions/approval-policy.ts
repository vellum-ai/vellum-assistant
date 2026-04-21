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
  /**
   * Auto-approve tools at or below this risk level when no rule matches.
   * - "none": prompt for everything (strictest)
   * - "low": auto-approve Low risk (default, matches existing behavior)
   * - "medium": auto-approve Low and Medium risk
   */
  autoApproveUpTo?: "none" | "low" | "medium";
}

/** The outcome of an approval policy evaluation. */
export interface ApprovalDecision {
  decision: "allow" | "prompt" | "deny";
  reason: string;
  /** Present only when the decision was driven by a matched rule. */
  matchedRule?: TrustRule;
}

/** An object that evaluates an approval context and returns a decision. */
export interface ApprovalPolicy {
  evaluate(context: ApprovalContext): ApprovalDecision;
}

// ── Default implementation ───────────────────────────────────────────────────

/**
 * Implements the approval decision policy used by `check()` in checker.ts.
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
 * 10. Risk ≤ autoApproveUpTo threshold → allow
 * 11. Risk > autoApproveUpTo threshold → prompt
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
        matchedRule,
      };
    }

    // ── 2. Ask rules always prompt ────────────────────────────────────
    if (matchedRule && matchedRule.decision === "ask") {
      return {
        decision: "prompt",
        reason: `Matched ask rule: ${matchedRule.pattern}`,
        matchedRule,
      };
    }

    // ── 3–5. Allow rule handling ──────────────────────────────────────
    if (matchedRule) {
      // 3. Allow rule + non-High → allow
      if (riskLevel !== RiskLevel.High) {
        return {
          decision: "allow",
          reason: `Matched trust rule: ${matchedRule.pattern}`,
          matchedRule,
        };
      }

      // 4. Allow rule + High + containerized bash → allow
      if (this.shouldAutoAllowHighRisk(toolName, isContainerized)) {
        return {
          decision: "allow",
          reason: `Matched trust rule in auto-allow-high-risk context: ${matchedRule.pattern}`,
          matchedRule,
        };
      }

      // 5. Allow rule + High (no auto-allow) → fall through to risk-based
      // Note: matchedRule is intentionally omitted from the risk-based
      // fallback return — the decision is driven by risk, not the rule.
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

    // ── 10–11. Risk-based fallback: compare risk against configured threshold ─
    const autoApproveUpTo = context.autoApproveUpTo ?? "low";
    const riskOrdinal: Record<string, number> = { low: 0, medium: 1, high: 2 };
    const thresholdOrdinal: Record<string, number> = {
      none: -1,
      low: 0,
      medium: 1,
    };
    const risk = riskOrdinal[riskLevel] ?? 2;
    const threshold = thresholdOrdinal[autoApproveUpTo] ?? 0;
    if (risk <= threshold) {
      return {
        decision: "allow",
        reason: `${riskLevel} risk: within auto-approve threshold`,
      };
    }
    return {
      decision: "prompt",
      reason: `${riskLevel} risk: above auto-approve threshold`,
    };
  }

  /**
   * Determines at runtime whether a high-risk operation should be auto-allowed.
   * Auto-allows high-risk operations when running in a containerized sandbox.
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
