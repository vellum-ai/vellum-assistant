/**
 * Shared business logic for invite management.
 *
 * Extracted from the IPC handlers in daemon/handlers/config-inbox.ts so that
 * both the HTTP routes and the IPC handlers call the same logic.
 *
 * Member/contact operations have been migrated to the /v1/contacts and
 * /v1/contacts/channels endpoints.
 */

import { isChannelId } from "../channels/types.js";
import {
  createInvite,
  findByTokenHash,
  hashToken,
  type IngressInvite,
  type InviteStatus,
  listInvites,
  revokeInvite,
} from "../memory/invite-store.js";
import { isValidE164 } from "../util/phone.js";
import { generateVoiceCode, hashVoiceCode } from "../util/voice-code.js";
import { getInviteAdapterRegistry } from "./channel-invite-transport.js";
import {
  type InviteRedemptionOutcome,
  redeemInvite as redeemInviteTyped,
  redeemVoiceInviteCode as redeemVoiceInviteCodeTyped,
  type VoiceRedemptionOutcome,
} from "./invite-redemption-service.js";

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

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function buildSharePayload(
  sourceChannel: string,
  rawToken?: string,
): InviteResponseData["share"] | undefined {
  if (!rawToken || !isChannelId(sourceChannel)) return undefined;
  const adapter = getInviteAdapterRegistry().get(sourceChannel);
  if (!adapter?.buildShareLink) return undefined;

  try {
    return adapter.buildShareLink({
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
