/**
 * Shared business logic for ingress member and invite management.
 *
 * Extracted from the IPC handlers in daemon/handlers/config-inbox.ts so that
 * both the HTTP routes and the IPC handlers call the same logic.
 */

import {
  createInvite,
  type IngressInvite,
  type InviteStatus,
  listInvites,
  redeemInvite,
  revokeInvite,
} from '../memory/ingress-invite-store.js';
import {
  blockMember,
  type IngressMember,
  listMembers,
  type MemberPolicy,
  type MemberStatus,
  revokeMember,
  upsertMember,
} from '../memory/ingress-member-store.js';
import { generateVoiceCode, hashVoiceCode } from '../util/voice-code.js';
import {
  type InviteRedemptionOutcome,
  type VoiceRedemptionOutcome,
  redeemInvite as redeemInviteTyped,
  redeemVoiceInviteCode as redeemVoiceInviteCodeTyped,
} from './invite-redemption-service.js';

// ---------------------------------------------------------------------------
// Response shapes — used by both HTTP routes and IPC handlers
// ---------------------------------------------------------------------------

export interface InviteResponseData {
  id: string;
  sourceChannel: string;
  token?: string;
  tokenHash: string;
  maxUses: number;
  useCount: number;
  expiresAt: number | null;
  status: string;
  note?: string;
  // Voice invite fields (present only for voice invites)
  expectedExternalUserId?: string;
  voiceCode?: string;
  voiceCodeDigits?: number;
  createdAt: number;
}

export interface MemberResponseData {
  id: string;
  sourceChannel: string;
  externalUserId?: string;
  externalChatId?: string;
  displayName?: string;
  username?: string;
  status: string;
  policy: string;
  lastSeenAt?: number;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function inviteToResponse(inv: IngressInvite, opts?: { rawToken?: string; voiceCode?: string }): InviteResponseData {
  return {
    id: inv.id,
    sourceChannel: inv.sourceChannel,
    ...(opts?.rawToken ? { token: opts.rawToken } : {}),
    tokenHash: inv.tokenHash,
    maxUses: inv.maxUses,
    useCount: inv.useCount,
    expiresAt: inv.expiresAt,
    status: inv.status,
    note: inv.note ?? undefined,
    ...(inv.expectedExternalUserId ? { expectedExternalUserId: inv.expectedExternalUserId } : {}),
    ...(opts?.voiceCode ? { voiceCode: opts.voiceCode } : {}),
    ...(inv.voiceCodeDigits != null ? { voiceCodeDigits: inv.voiceCodeDigits } : {}),
    createdAt: inv.createdAt,
  };
}

export function memberToResponse(m: IngressMember): MemberResponseData {
  return {
    id: m.id,
    sourceChannel: m.sourceChannel,
    externalUserId: m.externalUserId ?? undefined,
    externalChatId: m.externalChatId ?? undefined,
    displayName: m.displayName ?? undefined,
    username: m.username ?? undefined,
    status: m.status,
    policy: m.policy,
    lastSeenAt: m.lastSeenAt ?? undefined,
    createdAt: m.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type IngressResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Invite operations
// ---------------------------------------------------------------------------

export function createIngressInvite(params: {
  sourceChannel?: string;
  note?: string;
  maxUses?: number;
  expiresInMs?: number;
  // Voice invite parameters
  expectedExternalUserId?: string;
  voiceCodeDigits?: number;
}): IngressResult<InviteResponseData> {
  if (!params.sourceChannel) {
    return { ok: false, error: 'sourceChannel is required for create' };
  }

  // For voice invites: generate a one-time numeric code, hash it, and pass
  // the hash to the store. The plaintext code is included in the response
  // exactly once and never stored.
  let voiceCode: string | undefined;
  let voiceCodeHash: string | undefined;
  const isVoice = params.sourceChannel === 'voice';

  if (isVoice) {
    if (!params.expectedExternalUserId) {
      return { ok: false, error: 'expectedExternalUserId is required for voice invites' };
    }
    const digits = params.voiceCodeDigits ?? 6;
    if (!Number.isInteger(digits) || digits < 4 || digits > 10) {
      return { ok: false, error: 'voiceCodeDigits must be an integer between 4 and 10' };
    }
    voiceCode = generateVoiceCode(digits);
    voiceCodeHash = hashVoiceCode(voiceCode);
  }

  const { invite, rawToken } = createInvite({
    sourceChannel: params.sourceChannel,
    note: params.note,
    maxUses: params.maxUses,
    expiresInMs: params.expiresInMs,
    ...(isVoice ? {
      expectedExternalUserId: params.expectedExternalUserId,
      voiceCodeHash,
      voiceCodeDigits: params.voiceCodeDigits ?? 6,
    } : {}),
  });
  // Voice invites must not expose the token — callers must redeem via the
  // identity-bound voice code flow, not the generic token redemption path.
  return { ok: true, data: inviteToResponse(invite, { rawToken: isVoice ? undefined : rawToken, voiceCode }) };
}

export function listIngressInvites(params: {
  sourceChannel?: string;
  status?: string;
}): IngressResult<InviteResponseData[]> {
  const invites = listInvites({
    sourceChannel: params.sourceChannel,
    status: params.status as InviteStatus | undefined,
  });
  return {
    ok: true,
    data: invites.map((inv) => inviteToResponse(inv)),
  };
}

export function revokeIngressInvite(inviteId?: string): IngressResult<InviteResponseData> {
  if (!inviteId) {
    return { ok: false, error: 'inviteId is required for revoke' };
  }
  const revoked = revokeInvite(inviteId);
  if (!revoked) {
    return { ok: false, error: 'Invite not found or already revoked' };
  }
  return { ok: true, data: inviteToResponse(revoked) };
}

export function redeemIngressInvite(params: {
  token?: string;
  externalUserId?: string;
  externalChatId?: string;
  sourceChannel?: string;
}): IngressResult<InviteResponseData> {
  if (!params.token) {
    return { ok: false, error: 'token is required for redeem' };
  }
  const result = redeemInvite({
    rawToken: params.token,
    externalUserId: params.externalUserId,
    externalChatId: params.externalChatId,
    sourceChannel: params.sourceChannel,
  });
  if ('error' in result) {
    return { ok: false, error: result.error };
  }
  return { ok: true, data: inviteToResponse(result.invite) };
}

// ---------------------------------------------------------------------------
// Typed invite redemption — preferred entry point for new callers
// ---------------------------------------------------------------------------

export { type InviteRedemptionOutcome } from './invite-redemption-service.js';
export { type VoiceRedemptionOutcome } from './invite-redemption-service.js';

export function redeemIngressInviteTyped(params: {
  rawToken: string;
  sourceChannel: string;
  externalUserId?: string;
  externalChatId?: string;
  displayName?: string;
  username?: string;
  assistantId?: string;
}): InviteRedemptionOutcome {
  return redeemInviteTyped(params);
}

export function redeemVoiceInviteCode(params: {
  assistantId?: string;
  callerExternalUserId: string;
  sourceChannel: 'voice';
  code: string;
}): VoiceRedemptionOutcome {
  return redeemVoiceInviteCodeTyped(params);
}

// ---------------------------------------------------------------------------
// Member operations
// ---------------------------------------------------------------------------

export function listIngressMembers(params: {
  assistantId?: string;
  sourceChannel?: string;
  status?: string;
  policy?: string;
}): IngressResult<MemberResponseData[]> {
  const members = listMembers({
    assistantId: params.assistantId,
    sourceChannel: params.sourceChannel,
    status: params.status as MemberStatus | undefined,
    policy: params.policy as MemberPolicy | undefined,
  });
  return {
    ok: true,
    data: members.map(memberToResponse),
  };
}

export function upsertIngressMember(params: {
  sourceChannel?: string;
  externalUserId?: string;
  externalChatId?: string;
  displayName?: string;
  username?: string;
  policy?: string;
  status?: string;
  assistantId?: string;
}): IngressResult<MemberResponseData> {
  if (!params.sourceChannel) {
    return { ok: false, error: 'sourceChannel is required for upsert' };
  }
  if (!params.externalUserId && !params.externalChatId) {
    return { ok: false, error: 'At least one of externalUserId or externalChatId is required for upsert' };
  }
  const member = upsertMember({
    assistantId: params.assistantId,
    sourceChannel: params.sourceChannel,
    externalUserId: params.externalUserId,
    externalChatId: params.externalChatId,
    displayName: params.displayName,
    username: params.username,
    policy: params.policy as MemberPolicy | undefined,
    status: params.status as MemberStatus | undefined,
  });
  return { ok: true, data: memberToResponse(member) };
}

export function revokeIngressMember(memberId?: string, reason?: string): IngressResult<MemberResponseData> {
  if (!memberId) {
    return { ok: false, error: 'memberId is required for revoke' };
  }
  const revoked = revokeMember(memberId, reason);
  if (!revoked) {
    return { ok: false, error: 'Member not found or cannot be revoked' };
  }
  return { ok: true, data: memberToResponse(revoked) };
}

export function blockIngressMember(memberId?: string, reason?: string): IngressResult<MemberResponseData> {
  if (!memberId) {
    return { ok: false, error: 'memberId is required for block' };
  }
  const blocked = blockMember(memberId, reason);
  if (!blocked) {
    return { ok: false, error: 'Member not found or already blocked' };
  }
  return { ok: true, data: memberToResponse(blocked) };
}
