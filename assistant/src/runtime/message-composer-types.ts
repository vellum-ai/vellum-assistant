/**
 * Shared types for approval and guardian-action message composers.
 *
 * Extracted from approval-message-composer.ts, guardian-action-message-composer.ts,
 * and http-types.ts to break circular imports between composer ↔ http-types.
 */

// ---------------------------------------------------------------------------
// Approval message types
// ---------------------------------------------------------------------------

export type ApprovalMessageScenario =
  | "standard_prompt"
  | "guardian_prompt"
  | "reminder_prompt"
  | "guardian_delivery_failed"
  | "guardian_request_forwarded"
  | "guardian_disambiguation"
  | "guardian_identity_mismatch"
  | "request_pending_guardian"
  | "guardian_decision_outcome"
  | "guardian_expired_requester"
  | "guardian_expired_guardian"
  | "guardian_verify_success"
  | "guardian_verify_failed"
  | "guardian_verify_challenge_setup"
  | "guardian_verify_status_bound"
  | "guardian_verify_status_unbound"
  | "guardian_deny_no_identity"
  | "guardian_deny_no_binding"
  | "requester_cancel"
  | "approval_already_resolved"
  | "guardian_text_unavailable";

export interface ApprovalMessageContext {
  scenario: ApprovalMessageScenario;
  channel?: string;
  toolName?: string;
  requesterIdentifier?: string;
  guardianIdentifier?: string;
  pendingCount?: number;
  decision?: "approved" | "denied";
  richUi?: boolean;
  /** Pre-existing assistant text to reuse (macOS parity). */
  assistantPreface?: string;
  verifyCommand?: string;
  ttlSeconds?: number;
  failureReason?: string;
}

export interface ComposeApprovalMessageGenerativeOptions {
  /**
   * Optional fallback message to use when generation fails. If omitted,
   * the deterministic scenario fallback is used.
   */
  fallbackText?: string;
  /**
   * Require these standalone words in the generated output (case-insensitive).
   * Useful for plain-text decision flows where parser-compatible keywords
   * like yes/no/always must be present.
   */
  requiredKeywords?: string[];
  timeoutMs?: number;
  maxTokens?: number;
}

/**
 * Daemon-injected function that generates approval copy using a provider.
 * Returns generated text or `null` on failure (caller falls back to deterministic text).
 */
export type ApprovalCopyGenerator = (
  context: ApprovalMessageContext,
  options?: ComposeApprovalMessageGenerativeOptions,
) => Promise<string | null>;

// ---------------------------------------------------------------------------
// Guardian action message types
// ---------------------------------------------------------------------------

export type GuardianActionMessageScenario =
  | "caller_timeout_acknowledgment"
  | "caller_timeout_continue"
  | "guardian_late_answer_followup"
  | "guardian_followup_dispatching"
  | "guardian_followup_completed"
  | "guardian_followup_failed"
  | "guardian_followup_declined_ack"
  | "guardian_followup_clarification"
  | "guardian_pending_disambiguation"
  | "guardian_expired_disambiguation"
  | "guardian_followup_disambiguation"
  | "guardian_stale_answered"
  | "guardian_stale_expired"
  | "guardian_stale_followup"
  | "guardian_stale_superseded"
  | "guardian_superseded_remap"
  | "guardian_unknown_code"
  | "guardian_auto_matched"
  | "followup_call_started"
  | "followup_action_failed"
  | "guardian_answer_delivery_failed";

export interface GuardianActionMessageContext {
  scenario: GuardianActionMessageScenario;
  channel?: string;
  questionText?: string;
  callerIdentifier?: string;
  guardianIdentifier?: string;
  lateAnswerText?: string;
  followupAction?: string;
  failureReason?: string;
  counterpartyPhone?: string;
  requestCodes?: string[];
  /** The code the guardian provided that was not recognized. */
  unknownCode?: string;
  /** The code of the active request that supersedes the one the guardian targeted. */
  activeRequestCode?: string;
}

export interface ComposeGuardianActionMessageOptions {
  fallbackText?: string;
  requiredKeywords?: string[];
  maxTokens?: number;
  timeoutMs?: number;
}

/**
 * Daemon-injected function that generates guardian action copy using a provider.
 * Returns generated text or `null` on failure (caller falls back to deterministic text).
 */
export type GuardianActionCopyGenerator = (
  context: GuardianActionMessageContext,
  options?: ComposeGuardianActionMessageOptions,
) => Promise<string | null>;
