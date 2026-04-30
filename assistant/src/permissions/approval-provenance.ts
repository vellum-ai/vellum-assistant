import type { ApprovalMode, ApprovalReason } from "./types.js";

/**
 * Map a raw permission decision string (from permission-checker.ts) and
 * optional context discriminants to a stable (approvalMode, approvalReason)
 * pair for persistence and client display.
 *
 * Decision strings:
 *   "allow"                 — auto-allowed by policy (sandbox, trust rule, or threshold)
 *   "deny"                  — user denied via interactive prompt
 *   "denied"                — system denied (no interactive client, or trust rule deny)
 *   "platform_auto_approve" — guardian bash in platform-hosted session
 *   "guardian_auto_approve" — non-interactive guardian session within background threshold
 */
export function mapApprovalProvenance(
  decision: string,
  opts: {
    hasSandboxAutoApprove?: boolean;
    matchedTrustRuleId?: string;
    wasPrompted?: boolean;
    wasTimeout?: boolean;
    wasSystemCancel?: boolean;
  },
): { approvalMode: ApprovalMode; approvalReason: ApprovalReason } {
  if (decision === "platform_auto_approve") {
    return { approvalMode: "auto", approvalReason: "platform_auto_approve" };
  }

  if (decision === "guardian_auto_approve") {
    return { approvalMode: "auto", approvalReason: "within_threshold" };
  }

  if (decision === "allow") {
    if (opts.wasPrompted) {
      return { approvalMode: "prompted", approvalReason: "user_approved" };
    }
    if (opts.hasSandboxAutoApprove) {
      return { approvalMode: "auto", approvalReason: "sandbox_auto_approve" };
    }
    if (opts.matchedTrustRuleId) {
      return { approvalMode: "auto", approvalReason: "trust_rule_allowed" };
    }
    return { approvalMode: "auto", approvalReason: "within_threshold" };
  }

  // "deny" — interactive prompt denied, timed out, or system-cancelled
  if (decision === "deny") {
    if (opts.wasSystemCancel) {
      return { approvalMode: "prompted", approvalReason: "system_cancelled" };
    }
    if (opts.wasTimeout) {
      return { approvalMode: "prompted", approvalReason: "timed_out" };
    }
    return { approvalMode: "prompted", approvalReason: "user_denied" };
  }

  // "denied" — system denied without user interaction
  if (decision === "denied") {
    if (opts.matchedTrustRuleId) {
      return { approvalMode: "blocked", approvalReason: "trust_rule_denied" };
    }
    return { approvalMode: "blocked", approvalReason: "no_interactive_client" };
  }

  return { approvalMode: "unknown", approvalReason: "unknown" };
}
