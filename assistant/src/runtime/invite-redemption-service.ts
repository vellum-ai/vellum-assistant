/**
 * Typed invite redemption engine.
 *
 * Wraps the low-level invite store primitives with channel-scoped enforcement
 * and a discriminated-union outcome type so callers can handle every case
 * deterministically. The raw token is accepted as input but is never logged,
 * persisted, or returned in the outcome.
 */

import { findMember } from '../memory/ingress-member-store.js';
import { findByTokenHash, hashToken, markInviteExpired, redeemInvite as storeRedeemInvite } from '../memory/ingress-invite-store.js';

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

  // Validate the invite token before any membership checks to prevent
  // membership-status probing with arbitrary tokens.
  const tokenHash = hashToken(rawToken);
  const invite = findByTokenHash(tokenHash);

  if (!invite) {
    return { ok: false, reason: 'invalid_token' };
  }

  if (invite.status !== 'active') {
    const mapped = STORE_ERROR_TO_REASON[`invite_${invite.status}`];
    if (mapped) return mapped;
    return { ok: false, reason: 'invalid_token' };
  }

  if (invite.expiresAt <= Date.now()) {
    markInviteExpired(invite.id);
    return { ok: false, reason: 'expired' };
  }

  if (invite.useCount >= invite.maxUses) {
    return { ok: false, reason: 'max_uses_reached' };
  }

  // Enforce channel match: the token must belong to the channel the caller
  // is redeeming from.
  if (sourceChannel !== invite.sourceChannel) {
    return { ok: false, reason: 'channel_mismatch' };
  }

  // Token is valid — now safe to check existing membership without leaking
  // membership status to callers with bogus tokens.
  const existingMember = findMember({
    assistantId: assistantId ?? invite.assistantId,
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
