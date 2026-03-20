export enum RiskLevel {
  Low = "low",
  Medium = "medium",
  High = "high",
}

export interface TrustRule {
  id: string;
  tool: string;
  pattern: string;
  scope: string;
  decision: "allow" | "deny" | "ask";
  priority: number;
  createdAt: number;
  executionTarget?: string;
  allowHighRisk?: boolean;
}

export type UserDecision =
  | "allow"
  | "allow_10m"
  | "allow_conversation"
  | "always_allow"
  | "always_allow_high_risk"
  | "deny"
  | "always_deny"
  | "temporary_override"
  | "dangerously_skip_permissions";

/** Returns true for any allow-variant decision. Centralizes the check to prevent omissions when new allow variants are added. */
export function isAllowDecision(decision: UserDecision): boolean {
  return (
    decision === "allow" ||
    decision === "allow_10m" ||
    decision === "allow_conversation" ||
    decision === "always_allow" ||
    decision === "always_allow_high_risk" ||
    decision === "temporary_override" ||
    decision === "dangerously_skip_permissions"
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
}
