/**
 * Shared business logic for ingress member and invite management.
 *
 * Extracted from the IPC handlers in daemon/handlers/config-inbox.ts so that
 * both the HTTP routes and the IPC handlers call the same logic.
 */

import { isChannelId } from "../channels/types.js";
import { listContacts } from "../contacts/contact-store.js";
import {
  blockMemberContactsFirst,
  revokeMemberContactsFirst,
  upsertMemberContactsFirst,
} from "../contacts/contacts-write.js";
import {
  contactChannelToMemberRecord,
  type IngressMember,
  type MemberPolicy,
  type MemberStatus,
} from "../contacts/member-record-shim.js";
import type { ContactWithChannels } from "../contacts/types.js";
import {
  createInvite,
  findByTokenHash,
  hashToken,
  type IngressInvite,
  type InviteStatus,
  listInvites,
  revokeInvite,
} from "../memory/ingress-invite-store.js";
import { isValidE164 } from "../util/phone.js";
import { generateVoiceCode, hashVoiceCode } from "../util/voice-code.js";
import { getTransport } from "./channel-invite-transport.js";
import {
  type InviteRedemptionOutcome,
  redeemInvite as redeemInviteTyped,
  redeemVoiceInviteCode as redeemVoiceInviteCodeTyped,
  type VoiceRedemptionOutcome,
} from "./invite-redemption-service.js";

import "./channel-invite-transports/telegram.js";

// ---------------------------------------------------------------------------
// Response shapes — used by both HTTP routes and IPC handlers
// ---------------------------------------------------------------------------

export interface InviteResponseData {
  id: string;
  sourceChannel: string;
  token?: string;
  share?: {
    url: string;
    displayText: string;
  };
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
  friendName?: string;
  guardianName?: string;
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

function buildSharePayload(
  sourceChannel: string,
  rawToken?: string,
): InviteResponseData["share"] | undefined {
  if (!rawToken || !isChannelId(sourceChannel)) return undefined;
  const transport = getTransport(sourceChannel);
  if (!transport?.buildShareableInvite) return undefined;

  try {
    return transport.buildShareableInvite({
      rawToken,
      sourceChannel,
    });
  } catch {
    // Missing channel-specific config (e.g. Telegram bot username) should
    // not fail invite creation — callers can still use the raw token.
    return undefined;
  }
}

function inviteToResponse(
  inv: IngressInvite,
  opts?: { rawToken?: string; voiceCode?: string },
): InviteResponseData {
  const share = buildSharePayload(inv.sourceChannel, opts?.rawToken);
  return {
    id: inv.id,
    sourceChannel: inv.sourceChannel,
    ...(opts?.rawToken ? { token: opts.rawToken } : {}),
    ...(share ? { share } : {}),
    tokenHash: inv.tokenHash,
    maxUses: inv.maxUses,
    useCount: inv.useCount,
    expiresAt: inv.expiresAt,
    status: inv.status,
    note: inv.note ?? undefined,
    ...(inv.expectedExternalUserId
      ? { expectedExternalUserId: inv.expectedExternalUserId }
      : {}),
    ...(opts?.voiceCode ? { voiceCode: opts.voiceCode } : {}),
    ...(inv.voiceCodeDigits != null
      ? { voiceCodeDigits: inv.voiceCodeDigits }
      : {}),
    ...(inv.friendName ? { friendName: inv.friendName } : {}),
    ...(inv.guardianName ? { guardianName: inv.guardianName } : {}),
    createdAt: inv.createdAt,
  };
}

export function memberToResponse(m: IngressMember): MemberResponseData {
  return {
    id: m.contactId ? `${m.contactId}:${m.id}` : m.id,
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

function contactToMemberResponse(
  contact: ContactWithChannels,
): MemberResponseData[] {
  return contact.channels.map((ch) => ({
    id: `${contact.id}:${ch.id}`,
    sourceChannel: ch.type,
    externalUserId: ch.externalUserId ?? undefined,
    externalChatId: ch.externalChatId ?? undefined,
    displayName: contact.displayName,
    username: undefined,
    status: ch.status,
    policy: ch.policy,
    lastSeenAt: ch.lastSeenAt ?? undefined,
    createdAt: ch.createdAt,
  }));
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
  friendName?: string;
  guardianName?: string;
}): IngressResult<InviteResponseData> {
  if (!params.sourceChannel) {
    return { ok: false, error: "sourceChannel is required for create" };
  }

  // For voice invites: generate a one-time numeric code, hash it, and pass
  // the hash to the store. The plaintext code is included in the response
  // exactly once and never stored.
  let voiceCode: string | undefined;
  let voiceCodeHash: string | undefined;
  const isVoice = params.sourceChannel === "voice";

  if (isVoice) {
    if (!params.expectedExternalUserId) {
      return {
        ok: false,
        error: "expectedExternalUserId is required for voice invites",
      };
    }
    if (!isValidE164(params.expectedExternalUserId)) {
      return {
        ok: false,
        error:
          "expectedExternalUserId must be in E.164 format (e.g., +15551234567)",
      };
    }
    if (typeof params.friendName !== "string" || !params.friendName.trim()) {
      return { ok: false, error: "friendName is required for voice invites" };
    }
    if (
      typeof params.guardianName !== "string" ||
      !params.guardianName.trim()
    ) {
      return { ok: false, error: "guardianName is required for voice invites" };
    }
    voiceCode = generateVoiceCode(6);
    voiceCodeHash = hashVoiceCode(voiceCode);
  }

  const { invite, rawToken } = createInvite({
    sourceChannel: params.sourceChannel,
    note: params.note,
    maxUses: params.maxUses,
    expiresInMs: params.expiresInMs,
    ...(isVoice
      ? {
          expectedExternalUserId: params.expectedExternalUserId,
          voiceCodeHash,
          voiceCodeDigits: 6,
          friendName: params.friendName,
          guardianName: params.guardianName,
        }
      : {}),
  });
  // Voice invites must not expose the token — callers must redeem via the
  // identity-bound voice code flow, not the generic token redemption path.
  return {
    ok: true,
    data: inviteToResponse(invite, {
      rawToken: isVoice ? undefined : rawToken,
      voiceCode,
    }),
  };
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

export function revokeIngressInvite(
  inviteId?: string,
): IngressResult<InviteResponseData> {
  if (!inviteId) {
    return { ok: false, error: "inviteId is required for revoke" };
  }
  const revoked = revokeInvite(inviteId);
  if (!revoked) {
    return { ok: false, error: "Invite not found or already revoked" };
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
    return { ok: false, error: "token is required for redeem" };
  }
  if (!params.sourceChannel) {
    return { ok: false, error: "sourceChannel is required for redeem" };
  }
  const outcome = redeemInviteTyped({
    rawToken: params.token,
    sourceChannel: params.sourceChannel,
    externalUserId: params.externalUserId,
    externalChatId: params.externalChatId,
  });
  if (!outcome.ok) {
    return { ok: false, error: outcome.reason };
  }
  // For already_member, look up the invite by token hash to build the response
  if (outcome.type === "already_member") {
    const inv = findByTokenHash(hashToken(params.token));
    if (!inv) {
      return { ok: false, error: "Invite not found after redemption" };
    }
    return { ok: true, data: inviteToResponse(inv) };
  }
  // Look up the invite by token hash — same approach as the already_member path
  // above. Using findByTokenHash avoids the pagination limit of listInvites.
  const inv = findByTokenHash(hashToken(params.token));
  if (!inv) {
    return { ok: false, error: "Invite not found after redemption" };
  }
  return { ok: true, data: inviteToResponse(inv) };
}

// ---------------------------------------------------------------------------
// Typed invite redemption — preferred entry point for new callers
// ---------------------------------------------------------------------------

export { type InviteRedemptionOutcome } from "./invite-redemption-service.js";
export { type VoiceRedemptionOutcome } from "./invite-redemption-service.js";

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
  sourceChannel: "voice";
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
  // Use uncapped: true since this internal path needs the full dataset
  const allContacts = listContacts(Number.MAX_SAFE_INTEGER, "contact", {
    uncapped: true,
  });
  const members = allContacts.flatMap((c) => contactToMemberResponse(c));

  const filtered = members.filter((m) => {
    if (params.sourceChannel && m.sourceChannel !== params.sourceChannel)
      return false;
    if (params.status && m.status !== params.status) return false;
    if (params.policy && m.policy !== params.policy) return false;
    return true;
  });

  return { ok: true, data: filtered };
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
    return { ok: false, error: "sourceChannel is required for upsert" };
  }
  if (!params.externalUserId && !params.externalChatId) {
    return {
      ok: false,
      error:
        "At least one of externalUserId or externalChatId is required for upsert",
    };
  }
  const result = upsertMemberContactsFirst({
    assistantId: params.assistantId,
    sourceChannel: params.sourceChannel,
    externalUserId: params.externalUserId,
    externalChatId: params.externalChatId,
    displayName: params.displayName,
    username: params.username,
    policy: params.policy as MemberPolicy | undefined,
    status: params.status as MemberStatus | undefined,
  });
  if (!result) {
    return { ok: false, error: "Failed to upsert member" };
  }
  const member = contactChannelToMemberRecord(result.contact, result.channel);
  return { ok: true, data: memberToResponse(member) };
}

export function revokeIngressMember(
  memberId?: string,
  reason?: string,
): IngressResult<MemberResponseData> {
  if (!memberId) {
    return { ok: false, error: "memberId is required for revoke" };
  }
  const revokedResult = revokeMemberContactsFirst(memberId, reason);
  if (!revokedResult) {
    return { ok: false, error: "Member not found or cannot be revoked" };
  }
  const revoked = contactChannelToMemberRecord(
    revokedResult.contact,
    revokedResult.channel,
  );
  return { ok: true, data: memberToResponse(revoked) };
}

export function blockIngressMember(
  memberId?: string,
  reason?: string,
): IngressResult<MemberResponseData> {
  if (!memberId) {
    return { ok: false, error: "memberId is required for block" };
  }
  const blockedResult = blockMemberContactsFirst(memberId, reason);
  if (!blockedResult) {
    return { ok: false, error: "Member not found or already blocked" };
  }
  const blocked = contactChannelToMemberRecord(
    blockedResult.contact,
    blockedResult.channel,
  );
  return { ok: true, data: memberToResponse(blocked) };
}
