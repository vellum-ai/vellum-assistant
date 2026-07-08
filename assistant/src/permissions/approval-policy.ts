import type { OwnerKind } from "../tools/types.js";
import { RiskLevel } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Execution context for per-context threshold resolution. */
export type ExecutionContext = "conversation" | "background" | "headless";

/**
 * Auto-approve threshold: the highest risk level that is approved without
 * prompting. Single source of truth for the threshold vocabulary — the
 * gateway threshold reader and the sensitive-tool gate reuse this type.
 */
export type AutoApproveThreshold = "none" | "low" | "medium" | "high";

/** Contextual information that an approval policy uses to reach a decision. */
export interface ApprovalContext {
  riskLevel: RiskLevel;
  toolName: string;
  isContainerized: boolean;
  isWorkspaceScoped: boolean;
  /**
   * Owner kind of the tool, as recorded by the tool registry — "skill" /
   * "plugin" / "mcp" for extension-owned tools, `undefined` for core tools
   * (and for tools that aren't registered, e.g. unregistered skill tools
   * matched only via `hasManifestOverride`).
   */
  toolOrigin?: OwnerKind;
  /** Whether the tool's owning skill is a first-party bundled skill. */
  isSkillBundled?: boolean;
  /** Whether the tool has a manifest override (unregistered skill tool). */
  hasManifestOverride?: boolean;
  /** Whether the command's registry entry has sandboxAutoApprove: true. */
  hasSandboxAutoApprove?: boolean;
  /**
   * Resolved auto-approve threshold for this execution context.
   * - "none": prompt for everything (strictest)
   * - "low": auto-approve Low risk (default, matches existing behavior)
   * - "medium": auto-approve Low and Medium risk
   * - "high": auto-approve everything unconditionally
   */
  autoApproveUpTo?: AutoApproveThreshold;
}

// ── Ordinal maps for threshold comparison ─────────────────────────────────────
// Hoisted to module level since these are constant. Unknown enum values
// conservatively map to the strictest interpretation: risk defaults to 2 (high)
// and threshold defaults to 0 (low).
const RISK_ORDINAL: Record<string, number> = { low: 0, medium: 1, high: 2 };
const THRESHOLD_ORDINAL: Record<string, number> = {
  none: -1,
  low: 0,
  medium: 1,
  high: 2,
};

/**
 * Check whether a risk level falls within the configured auto-approve threshold.
 * Returns `true` when the risk is at or below the threshold (i.e. auto-approve).
 */
function isRiskWithinThreshold(
  riskLevel: string,
  autoApproveUpTo: string | undefined,
): boolean {
  const risk = RISK_ORDINAL[riskLevel] ?? 2;
  const threshold = THRESHOLD_ORDINAL[autoApproveUpTo ?? "low"] ?? 0;
  return risk <= threshold;
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
 * Implements the approval decision policy used by `check()` in checker.ts.
 *
 * The decision flow:
 *
 * 1. Sandbox auto-approve: bash + sandboxAutoApprove + autoApproveUpTo !== "none" → allow
 *    (Path resolution is baked into `hasSandboxAutoApprove` upstream: containerized
 *    environments skip path checks; non-containerized environments validate all
 *    path arguments against the workspace root.)
 * 2. Third-party skill tool + risk > autoApproveUpTo → prompt
 *    Third-party skill tool + risk ≤ autoApproveUpTo → allow (threshold overrides)
 * 3. Low + workspace-scoped + within threshold → allow
 * 4. Low + bundled skill + within threshold → allow
 * 5. Risk ≤ autoApproveUpTo threshold → allow
 * 6. Risk > autoApproveUpTo threshold → prompt
 *
 * Trust Rules do not appear in this flow: they are per-action risk
 * re-classifications applied inside the gateway classifiers, so their
 * effect arrives here already folded into `riskLevel` — there is no
 * separate allow/ask/deny rule axis.
 */
export class DefaultApprovalPolicy implements ApprovalPolicy {
  evaluate(context: ApprovalContext): ApprovalDecision {
    const {
      riskLevel,
      toolName,
      isWorkspaceScoped,
      toolOrigin,
      isSkillBundled,
      hasManifestOverride,
      hasSandboxAutoApprove,
    } = context;

    // ── 1. Sandbox auto-approve: bash + allowlisted → allow ──
    // Respects the autoApproveUpTo threshold: when set to "none", sandbox
    // auto-approve is suppressed — the user wants to approve everything.
    // Path resolution is baked into `hasSandboxAutoApprove` upstream:
    // containerized environments skip path checks (entire fs is workspace),
    // non-containerized environments validate all path args against workspace root.
    if (
      toolName === "bash" &&
      hasSandboxAutoApprove === true &&
      context.autoApproveUpTo !== "none"
    ) {
      return {
        decision: "allow",
        reason: "Workspace filesystem operation (sandbox auto-approve)",
      };
    }

    // ── 2. Third-party skill tool → prompt (unless threshold covers it)
    // Plugin- and skill-owned tools are both treated as extension-class
    // for approval purposes: external by default, prompt unless bundled.
    // MCP-owned tools fall through to the core risk-based path.
    const isExtensionOwned = toolOrigin === "skill" || toolOrigin === "plugin";
    const isThirdPartySkill =
      (isExtensionOwned && !isSkillBundled) ||
      (hasManifestOverride && !toolOrigin);
    if (isThirdPartySkill) {
      if (isRiskWithinThreshold(riskLevel, context.autoApproveUpTo)) {
        return {
          decision: "allow",
          reason: `${riskLevel} risk: within auto-approve threshold (skill tool)`,
        };
      }
      return {
        decision: "prompt",
        reason: "Skill tool: requires approval by default",
      };
    }

    // ── 3. Low + workspace-scoped + within threshold → allow ──
    if (
      riskLevel === RiskLevel.Low &&
      isWorkspaceScoped &&
      isRiskWithinThreshold(riskLevel, context.autoApproveUpTo)
    ) {
      return {
        decision: "allow",
        reason: "Workspace-scoped low-risk operation auto-allowed",
      };
    }

    // ── 4. Low + bundled skill + within threshold → allow ──
    if (
      riskLevel === RiskLevel.Low &&
      toolOrigin === "skill" &&
      isSkillBundled &&
      isRiskWithinThreshold(riskLevel, context.autoApproveUpTo)
    ) {
      return {
        decision: "allow",
        reason: "Bundled skill tool: low risk, auto-allowed",
      };
    }

    // ── 5–6. Risk-based fallback: compare risk against configured threshold ─
    if (isRiskWithinThreshold(riskLevel, context.autoApproveUpTo)) {
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
}
