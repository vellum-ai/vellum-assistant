export type {
  AllowlistOption,
  ScopeOption,
} from "@vellumai/skill-host-contracts";
export { RiskLevel } from "@vellumai/skill-host-contracts";

export type ApprovalMode = "prompted" | "auto" | "blocked" | "unknown";

export type ApprovalReason =
  | "user_approved"
  | "user_denied"
  | "timed_out"
  | "within_threshold"
  | "trust_rule_allowed"
  | "trust_rule_denied"
  | "sandbox_auto_approve"
  | "platform_auto_approve"
  | "no_interactive_client"
  | "grant_scoped_consumed"
  | "system_cancelled"
  | "unknown";

export type RiskThreshold = "none" | "low" | "medium" | "high";

export const RISK_ORDINAL: Record<string, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

export const THRESHOLD_ORDINAL: Record<string, number> = {
  none: -1,
  low: 0,
  medium: 1,
  high: 2,
};

/** A persistent trust rule stored on disk and used for permission matching. */
export interface TrustRule {
  id: string;
  tool: string;
  pattern: string;
  decision: "allow" | "deny" | "ask";
  priority: number;
  createdAt: number;
  scope?: string;
  executionTarget?: string;
  userModifiedAt?: number;
}

export type UserDecision = "allow" | "deny";

export function isAllowDecision(decision: UserDecision): boolean {
  return decision === "allow";
}

export interface PermissionCheckResult {
  decision: "allow" | "deny" | "prompt";
  reason: string;
  matchedRule?: TrustRule;
  /** True when the decision was taken via the sandbox auto-approve path. */
  hasSandboxAutoApprove?: boolean;
}

/** Contextual information passed alongside a permission check for policy decisions. */
export interface PolicyContext {
  executionTarget?: string;
  /**
   * Execution context for per-context threshold resolution.
   * - "conversation": interactive client session (default)
   * - "background": non-interactive guardian session (e.g. scheduled jobs)
   * - "headless": non-interactive non-guardian session
   */
  executionContext?: "conversation" | "background" | "headless";
  /** Conversation ID for per-conversation threshold overrides. */
  conversationId?: string;
}
