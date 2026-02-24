/**
 * Layered approval message composition system.
 *
 * Generates approval prompt text through a priority chain:
 *   1. Assistant preface (macOS parity — reuse existing assistant text)
 *   2. Deterministic fallback templates (natural, scenario-specific messages)
 *
 * A provider-backed generation layer can be inserted between 1 and 2 later.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ApprovalMessageScenario =
  | 'standard_prompt'
  | 'guardian_prompt'
  | 'reminder_prompt'
  | 'guardian_delivery_failed'
  | 'guardian_request_forwarded'
  | 'guardian_disambiguation'
  | 'guardian_identity_mismatch'
  | 'request_pending_guardian'
  | 'guardian_decision_outcome'
  | 'guardian_expired_requester'
  | 'guardian_expired_guardian'
  | 'guardian_verify_success'
  | 'guardian_verify_failed'
  | 'guardian_verify_challenge_setup'
  | 'guardian_verify_status_bound'
  | 'guardian_verify_status_unbound'
  | 'guardian_deny_no_identity'
  | 'guardian_deny_no_binding';

export interface ApprovalMessageContext {
  scenario: ApprovalMessageScenario;
  channel?: string;
  toolName?: string;
  requesterIdentifier?: string;
  guardianIdentifier?: string;
  pendingCount?: number;
  decision?: 'approved' | 'denied';
  richUi?: boolean;
  /** Pre-existing assistant text to reuse (macOS parity). */
  assistantPreface?: string;
  verifyCommand?: string;
  ttlSeconds?: number;
  failureReason?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compose an approval message using layered source selection:
 *   1. If an assistant preface is provided and non-empty, return it directly.
 *   2. Otherwise fall back to a deterministic scenario-specific template.
 */
export function composeApprovalMessage(context: ApprovalMessageContext): string {
  if (context.assistantPreface && context.assistantPreface.trim().length > 0) {
    return context.assistantPreface;
  }

  return getFallbackMessage(context);
}

// ---------------------------------------------------------------------------
// Deterministic fallback templates
// ---------------------------------------------------------------------------

/**
 * Return a scenario-specific deterministic fallback message.
 *
 * Each template is slightly more conversational than the old hard-coded
 * strings while preserving all required semantic content (tool name,
 * who must approve, next action, etc.).
 */
export function getFallbackMessage(context: ApprovalMessageContext): string {
  switch (context.scenario) {
    case 'standard_prompt':
      return `I'd like to use the tool "${context.toolName ?? 'unknown'}". Would you like to allow this?`;

    case 'guardian_prompt':
      return `${context.requesterIdentifier ?? 'A user'} is requesting to use "${context.toolName ?? 'unknown'}". Please approve or deny this request.`;

    case 'reminder_prompt':
      return "I'm still waiting for your decision on the pending approval request.";

    case 'guardian_delivery_failed':
      return "I wasn't able to reach the guardian to request approval. The request has been denied for safety.";

    case 'guardian_request_forwarded':
      return `Your request to use "${context.toolName ?? 'unknown'}" has been forwarded to the guardian for approval. I'll let you know once they decide.`;

    case 'guardian_disambiguation':
      return `There are ${context.pendingCount ?? 'multiple'} pending approval requests. Please use the approval buttons to specify which request you're responding to.`;

    case 'guardian_identity_mismatch':
      return 'This approval request can only be handled by the designated guardian.';

    case 'request_pending_guardian':
      return 'Your request is pending guardian approval. Please wait for the guardian to respond.';

    case 'guardian_decision_outcome':
      return `The guardian has ${context.decision ?? 'decided on'} your request to use "${context.toolName ?? 'unknown'}".`;

    case 'guardian_expired_requester':
      return `The approval request for "${context.toolName ?? 'unknown'}" has expired without a guardian response. The request has been denied.`;

    case 'guardian_expired_guardian':
      return `The approval request from ${context.requesterIdentifier ?? 'the requester'} for "${context.toolName ?? 'unknown'}" has expired.`;

    case 'guardian_verify_success':
      return 'Guardian verification successful! You are now set as the guardian for this channel.';

    case 'guardian_verify_failed':
      return `Verification failed. ${context.failureReason ?? 'Please try again.'}`;

    case 'guardian_verify_challenge_setup':
      return `To complete guardian verification, send ${context.verifyCommand ?? 'the verification command'} within ${context.ttlSeconds ?? 60} seconds.`;

    case 'guardian_verify_status_bound':
      return 'A guardian is currently active for this channel.';

    case 'guardian_verify_status_unbound':
      return 'No guardian is currently configured for this channel.';

    case 'guardian_deny_no_identity':
      return 'This action requires approval, but your identity could not be verified. The request has been denied for safety.';

    case 'guardian_deny_no_binding':
      return 'This action requires guardian approval, but no guardian has been configured for this channel. The request has been denied for safety.';

    default: {
      // Exhaustive check — TypeScript will flag if a scenario is missing.
      const _exhaustive: never = context.scenario;
      return `Approval required. ${String(_exhaustive)}`;
    }
  }
}
