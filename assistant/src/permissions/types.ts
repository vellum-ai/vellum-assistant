export type {
  AllowlistOption,
  ScopeOption,
} from "@vellumai/skill-host-contracts";
export { RiskLevel } from "@vellumai/skill-host-contracts";

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
