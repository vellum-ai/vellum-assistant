/**
 * Deterministic reply templates for invite token redemption outcomes.
 *
 * These messages are returned directly to the user without passing through
 * the LLM pipeline, ensuring consistent and predictable responses for
 * every invite redemption outcome.
 */

import type { InviteRedemptionOutcome } from './invite-redemption-service.js';

// ---------------------------------------------------------------------------
// Template strings
// ---------------------------------------------------------------------------

export const INVITE_REPLY_TEMPLATES = {
  redeemed: "Welcome! You've been granted access via invite link.",
  already_member: 'You already have access.',
  invalid_token: 'This invite link is no longer valid.',
  expired: 'This invite link is no longer valid.',
  revoked: 'This invite link is no longer valid.',
  max_uses_reached: 'This invite link is no longer valid.',
  channel_mismatch: 'This invite link is not valid for this channel.',
  missing_identity: 'Unable to process this invite. Please contact the person who shared it.',
  generic_failure: 'Unable to process this invite. Please contact the person who shared it.',
} as const;

// ---------------------------------------------------------------------------
// Outcome-to-reply resolver
// ---------------------------------------------------------------------------

/**
 * Map an `InviteRedemptionOutcome` to a deterministic reply string.
 */
export function getInviteRedemptionReply(outcome: InviteRedemptionOutcome): string {
  if (outcome.ok) {
    return INVITE_REPLY_TEMPLATES[outcome.type];
  }
  return INVITE_REPLY_TEMPLATES[outcome.reason] ?? INVITE_REPLY_TEMPLATES.generic_failure;
}
