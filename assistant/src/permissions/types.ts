import type { TrustRuleBase } from "@vellumai/ces-contracts";

/**
 * Re-exported TrustRule type from `@vellumai/ces-contracts`.
 *
 * The contracts package defines `TrustRule` as a discriminated union over tool
 * families (scoped, URL, managed-skill, skill-load, generic). Some variants
 * don't carry `executionTarget`. To maintain backward
 * compatibility with existing callsites that access those fields on any rule,
 * we flatten the union here by intersecting the base with the optional fields.
 */
export type TrustRule = TrustRuleBase & {
  scope?: string;
  executionTarget?: string;
};

export enum RiskLevel {
  Low = "low",
  Medium = "medium",
  High = "high",
}

export type UserDecision =
  | "allow"
  | "allow_10m"
  | "allow_conversation"
  | "always_allow"
  | "deny"
  | "always_deny"
  | "temporary_override";

/** Returns true for any allow-variant decision. Centralizes the check to prevent omissions when new allow variants are added. */
export function isAllowDecision(decision: UserDecision): boolean {
  return (
    decision === "allow" ||
    decision === "allow_10m" ||
    decision === "allow_conversation" ||
    decision === "always_allow" ||
    decision === "temporary_override"
  );
}

export interface PermissionCheckResult {
  decision: "allow" | "deny" | "prompt";
  reason: string;
  matchedRule?: TrustRule;
}

export interface AllowlistOption {
  label: string;
  description: string;
  pattern: string;
}

export interface ScopeOption {
  label: string;
  scope: string;
}

/** Contextual information passed alongside a permission check for policy decisions. */
export interface PolicyContext {
  executionTarget?: string;
  /** Ephemeral rules for task-scoped permissions — checked before persistent trust.json rules. */
  ephemeralRules?: TrustRule[];
  /**
   * Execution context for per-context threshold resolution.
   * - "conversation": interactive client session (default)
   * - "background": non-interactive guardian session (e.g. scheduled jobs)
   * - "headless": non-interactive non-guardian session
   */
  executionContext?: "conversation" | "background" | "headless";
}
