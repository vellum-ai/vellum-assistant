import type { PermissionsConfig } from "../config/schemas/security.js";
import type { TrustRule } from "./types.js";
import { RiskLevel } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Execution context for per-context threshold resolution. */
export type ExecutionContext = "conversation" | "background" | "headless";

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
  /** Whether the command's registry entry has sandboxAutoApprove: true. */
  hasSandboxAutoApprove?: boolean;
  /**
   * Resolved auto-approve threshold for this execution context.
   * - "none": prompt for everything (strictest)
   * - "low": auto-approve Low risk (default, matches existing behavior)
   * - "medium": auto-approve Low and Medium risk
   * - "high": auto-approve everything unconditionally
   */
  autoApproveUpTo?: "none" | "low" | "medium" | "high";
  /**
   * When true, the auto-approve threshold was resolved from the gateway
   * (permission-controls-v3). This enables threshold-based override of
   * ask rules — the user's threshold setting takes precedence over
   * default ask rules when the risk falls within the threshold.
   */
  isGatewayThreshold?: boolean;
}

// ── Threshold resolution ─────────────────────────────────────────────────────

/**
 * Resolve the `autoApproveUpTo` config value to a scalar threshold for
 * the given execution context.
 *
 * - Scalar string → returned as-is for all contexts
 * - Object with per-context overrides → returns the value for the context
 *
 * When `executionContext` is omitted, defaults to `"conversation"`.
 */
/**
 * Per-context defaults when `autoApproveUpTo` is omitted from config entirely.
 *
 * In production the Zod schema defaults to the equivalent object form, so this
 * map acts as defense-in-depth for test configs / direct callers that bypass
 * schema validation.
 *
 * Note: when the user sets a scalar value (e.g. `"low"`), it applies uniformly
 * to ALL contexts — including headless, whose default here is `"none"`. A scalar
 * `"low"` is therefore *less strict* than the headless default. This is
 * intentional: the user explicitly chose a uniform threshold.
 */
const CONTEXT_DEFAULTS: Record<
  ExecutionContext,
  "none" | "low" | "medium" | "high"
> = {
  conversation: "low",
  background: "medium",
  headless: "none",
};

export function resolveThreshold(
  configValue: PermissionsConfig["autoApproveUpTo"] | undefined,
  executionContext?: ExecutionContext,
): "none" | "low" | "medium" | "high" {
  if (configValue == null) {
    return CONTEXT_DEFAULTS[executionContext ?? "conversation"];
  }
  if (typeof configValue === "string") {
    return configValue;
  }
  const ctx = executionContext ?? "conversation";
  return configValue[ctx];
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
 * 2. Ask rule + risk > autoApproveUpTo → prompt
 *    Ask rule + risk ≤ autoApproveUpTo → allow (v3 only: threshold overrides ask)
 *    Exception: skill_load_dynamic ask rules always prompt (inline-command safety gate)
 * 3. Sandbox auto-approve: workspace mode + bash + sandboxAutoApprove → allow
 *    (Path resolution is baked into `hasSandboxAutoApprove` upstream: containerized
 *    environments skip path checks; non-containerized environments validate all
 *    path arguments against the workspace root.)
 * 4. Allow rule + non-High → allow
 * 5. Allow rule + High → fall through to risk-based
 * 6. No rule + third-party skill tool + risk > autoApproveUpTo → prompt
 *    No rule + third-party skill tool + risk ≤ autoApproveUpTo → allow (v3 only)
 * 7. No rule + strict mode + risk > autoApproveUpTo → prompt
 *    No rule + strict mode + risk ≤ autoApproveUpTo → allow (v3 only)
 * 8. No rule + workspace mode + Low + workspace-scoped → allow
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
      isWorkspaceScoped,
      toolOrigin,
      isSkillBundled,
      hasManifestOverride,
      hasSandboxAutoApprove,
    } = context;

    // ── 1. Deny rules apply at ALL risk levels ────────────────────────
    if (matchedRule && matchedRule.decision === "deny") {
      return {
        decision: "deny",
        reason: `Blocked by deny rule: ${matchedRule.pattern}`,
        matchedRule,
      };
    }

    // ── 2. Ask rules prompt — unless the gateway threshold covers the risk.
    // When permission-controls-v3 is active (isGatewayThreshold), the user's
    // threshold setting takes precedence over ask rules: if the risk falls
    // within autoApproveUpTo, the ask rule is overridden and the tool
    // auto-approves. Without v3, ask rules always prompt (preserving
    // backward-compatible behavior for default ask rules on host tools, etc.).
    // Exception: skill_load_dynamic ask rules always prompt — they gate
    // inline-command skill loads that execute embedded commands and must
    // never be silently auto-approved.
    if (matchedRule && matchedRule.decision === "ask") {
      const isDynamicSkillAsk = matchedRule.pattern.startsWith(
        "skill_load_dynamic:",
      );
      if (
        !isDynamicSkillAsk &&
        context.isGatewayThreshold &&
        isRiskWithinThreshold(riskLevel, context.autoApproveUpTo)
      ) {
        return {
          decision: "allow",
          reason: `${riskLevel} risk: within auto-approve threshold (ask rule overridden)`,
        };
      }
      return {
        decision: "prompt",
        reason: `Matched ask rule: ${matchedRule.pattern}`,
        matchedRule,
      };
    }

    // ── 3. Sandbox auto-approve: bash + allowlisted → allow ──
    // Only fires in workspace mode — strict mode always requires explicit rules.
    // Respects the autoApproveUpTo threshold: when set to "none" (Strict),
    // sandbox auto-approve is suppressed — the user wants to approve everything.
    // Path resolution is baked into `hasSandboxAutoApprove` upstream:
    // containerized environments skip path checks (entire fs is workspace),
    // non-containerized environments validate all path args against workspace root.
    if (
      permissionsMode === "workspace" &&
      toolName === "bash" &&
      hasSandboxAutoApprove === true &&
      context.autoApproveUpTo !== "none"
    ) {
      return {
        decision: "allow",
        reason: "Workspace filesystem operation (sandbox auto-approve)",
      };
    }

    // ── 4–5. Allow rule handling ──────────────────────────────────────
    if (matchedRule) {
      if (riskLevel !== RiskLevel.High) {
        return {
          decision: "allow",
          reason: `Matched trust rule: ${matchedRule.pattern}`,
          matchedRule,
        };
      }
      // High risk: fall through to risk-based regardless of rule
    }

    // ── 6. No rule + third-party skill tool → prompt (unless v3 threshold covers it)
    if (!matchedRule) {
      const isThirdPartySkill =
        (toolOrigin === "skill" && !isSkillBundled) ||
        (hasManifestOverride && !toolOrigin);
      if (isThirdPartySkill) {
        if (
          context.isGatewayThreshold &&
          isRiskWithinThreshold(riskLevel, context.autoApproveUpTo)
        ) {
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
    }

    // ── 7. No rule + strict mode → prompt (unless v3 threshold covers it)
    if (permissionsMode === "strict" && !matchedRule) {
      if (
        context.isGatewayThreshold &&
        isRiskWithinThreshold(riskLevel, context.autoApproveUpTo)
      ) {
        return {
          decision: "allow",
          reason: `${riskLevel} risk: within auto-approve threshold (strict mode overridden)`,
        };
      }
      return {
        decision: "prompt",
        reason: "Strict mode: no matching rule, requires approval",
      };
    }

    // ── 8. No rule + workspace mode + Low + workspace-scoped → allow ──
    if (
      permissionsMode === "workspace" &&
      !matchedRule &&
      riskLevel === RiskLevel.Low
    ) {
      if (isWorkspaceScoped) {
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
