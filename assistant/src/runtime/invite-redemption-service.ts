/**
 * Typed invite redemption engine.
 *
 * Wraps the low-level invite store primitives with channel-scoped enforcement
 * and a discriminated-union outcome type so callers can handle every case
 * deterministically. The raw token is accepted as input but is never logged,
 * persisted, or returned in the outcome.
 */

import { findMember } from '../memory/ingress-member-store.js';
import { redeemInvite as storeRedeemInvite } from '../memory/ingress-invite-store.js';

// ---------------------------------------------------------------------------
// Outcome type
// ---------------------------------------------------------------------------

export type InviteRedemptionOutcome =
  | { ok: true; type: 'redeemed'; memberId: string; inviteId: string }
  | { ok: true; type: 'already_member'; memberId: string }
  | { ok: false; reason: 'invalid_token' | 'expired' | 'revoked' | 'max_uses_reached' | 'channel_mismatch' | 'missing_identity' };

// ---------------------------------------------------------------------------
// Error-string to typed-reason mapping
// ---------------------------------------------------------------------------

const STORE_ERROR_TO_REASON: Record<string, InviteRedemptionOutcome & { ok: false } | undefined> = {
  invite_not_found: { ok: false, reason: 'invalid_token' },
  invite_expired: { ok: false, reason: 'expired' },
  invite_revoked: { ok: false, reason: 'revoked' },
  invite_redeemed: { ok: false, reason: 'max_uses_reached' },
  invite_max_uses_reached: { ok: false, reason: 'max_uses_reached' },
  invite_channel_mismatch: { ok: false, reason: 'channel_mismatch' },
};

// ---------------------------------------------------------------------------
// redeemInvite
// ---------------------------------------------------------------------------

export function redeemInvite(params: {
  rawToken: string;
  sourceChannel: string;
  externalUserId?: string;
  externalChatId?: string;
  displayName?: string;
  username?: string;
  assistantId?: string;
}): InviteRedemptionOutcome {
  const { rawToken, sourceChannel, externalUserId, externalChatId, displayName, username, assistantId } = params;

  if (!externalUserId && !externalChatId) {
    return { ok: false, reason: 'missing_identity' };
  }

  // Check if the caller is already a member on this channel
  const existingMember = findMember({
    assistantId,
    sourceChannel,
    externalUserId,
    externalChatId,
  });

  if (existingMember && existingMember.status === 'active') {
    return { ok: true, type: 'already_member', memberId: existingMember.id };
  }

  // Delegate to the store-level redeem which handles token lookup, expiry,
  // use-count, and transactional member creation. Channel enforcement is
  // applied by passing sourceChannel so the store checks it.
  const result = storeRedeemInvite({
    rawToken,
    sourceChannel,
    externalUserId,
    externalChatId,
    displayName,
    username,
  });

  if ('error' in result) {
    const mapped = STORE_ERROR_TO_REASON[result.error];
    if (mapped) return mapped;
    // Fallback for any unrecognized store error
    return { ok: false, reason: 'invalid_token' };
  }

  return {
    ok: true,
    type: 'redeemed',
    memberId: result.member.id,
    inviteId: result.invite.id,
  };
}
