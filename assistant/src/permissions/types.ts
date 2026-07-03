export type {
  AllowlistOption,
  ScopeOption,
} from "../tools/tool-types.js";
export { RiskLevel } from "../tools/tool-types.js";

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
  /**
   * Origin tag of the turn driving this permission check (the conversation's
   * `TitleOrigin`, e.g. "memory_retrospective"). Background jobs cannot answer
   * interactive approval prompts, so the checker uses this — together with
   * {@link trustClass} / {@link sourceChannel} — to scope narrow non-interactive
   * auto-grants to a specific internal origin without broadening any other
   * session.
   */
  requestOrigin?: string;
  /** Trust classification of the actor driving the turn (e.g. "guardian"). */
  trustClass?: string;
  /** Source channel the turn arrived on (e.g. "vellum" for internal jobs). */
  sourceChannel?: string;
  /**
   * Whether procedural-memory-as-skills is active for this assistant (memory-v3
   * is live). Precomputed in {@link buildPolicyContext} so the checker can gate
   * the memory-retrospective skill-authoring auto-grant on the feature without
   * reading config itself. Undefined/false when the feature is inactive — the
   * grant then never fires.
   */
  procToSkillsActive?: boolean;
}
