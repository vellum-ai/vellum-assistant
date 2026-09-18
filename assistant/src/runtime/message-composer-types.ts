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
  | "guardian_identity_mismatch"
  | "request_pending_guardian"
  | "guardian_verify_failed"
  | "guardian_verify_challenge_setup"
  | "approval_already_resolved";

export interface ApprovalMessageContext {
  scenario: ApprovalMessageScenario;
  channel?: string;
  toolName?: string;
  requesterIdentifier?: string;
  richUi?: boolean;
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

/** The one guardian-action notice still sent: a request expired unanswered. */
export type GuardianActionMessageScenario = "guardian_stale_expired";

export interface GuardianActionMessageContext {
  scenario: GuardianActionMessageScenario;
}
