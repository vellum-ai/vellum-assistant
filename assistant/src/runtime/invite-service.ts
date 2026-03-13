/**
 * Shared business logic for invite management.
 *
 * Extracted from the handlers in daemon/handlers/config-inbox.ts so that
 * both the HTTP routes and the message handlers call the same logic.
 *
 * Member/contact operations have been migrated to the /v1/contacts and
 * /v1/contacts/channels endpoints.
 */

import { startInviteCall } from "../calls/call-domain.js";
import { isChannelId } from "../channels/types.js";
import {
  createInvite,
  findById,
  findByTokenHash,
  hashToken,
  type IngressInvite,
  type InviteStatus,
  listInvites,
  markInviteExpired,
  revokeInvite,
} from "../memory/invite-store.js";
import {
  DECLINED_BY_USER_SENTINEL,
  DEFAULT_USER_REFERENCE,
  resolveGuardianName,
} from "../prompts/user-reference.js";
import { isValidE164 } from "../util/phone.js";
import { generateVoiceCode, hashVoiceCode } from "../util/voice-code.js";
import {
  getInviteAdapterRegistry,
  resolveAdapterHandle,
} from "./channel-invite-transport.js";
import { generateInviteInstruction } from "./invite-instruction-generator.js";
import {
  type InviteRedemptionOutcome,
  redeemInvite as redeemInviteTyped,
  redeemVoiceInviteCode as redeemVoiceInviteCodeTyped,
  type VoiceRedemptionOutcome,
} from "./invite-redemption-service.js";

// ---------------------------------------------------------------------------
// Response shapes — used by both HTTP routes and message handlers
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
  // Non-voice invite fields (present only for non-voice invites)
  inviteCode?: string;
  guardianInstruction?: string;
  channelHandle?: string;
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
  opts?: {
    rawToken?: string;
    voiceCode?: string;
    inviteCode?: string;
    guardianInstruction?: string;
    channelHandle?: string;
  },
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
    ...(opts?.inviteCode ? { inviteCode: opts.inviteCode } : {}),
    ...(opts?.guardianInstruction
      ? { guardianInstruction: opts.guardianInstruction }
      : {}),
    ...(opts?.channelHandle ? { channelHandle: opts.channelHandle } : {}),
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

export async function createIngressInvite(params: {
  sourceChannel?: string;
  note?: string;
  maxUses?: number;
  expiresInMs?: number;
  // Contact display name for personalizing invite instructions
  contactName?: string;
  // Voice invite parameters
  expectedExternalUserId?: string;
  voiceCodeDigits?: number;
  friendName?: string;
  guardianName?: string;
  contactId: string;
}): Promise<IngressResult<InviteResponseData>> {
  if (!params.sourceChannel) {
    return { ok: false, error: "sourceChannel is required for create" };
  }

  if (!params.contactId) {
    return { ok: false, error: "contactId is required for create" };
  }

  // For voice invites: generate a one-time numeric code, hash it, and pass
  // the hash to the store. The plaintext code is included in the response
  // exactly once and never stored.
  let voiceCode: string | undefined;
  let voiceCodeHash: string | undefined;
  let effectiveGuardianName: string | undefined;
  const isVoice = params.sourceChannel === "phone";

  // For non-voice invites: generate a 6-digit invite code for guardian-mediated
  // redemption. The plaintext code is returned once in the response; only the
  // hash is persisted for later redemption lookup.
  let inviteCode: string | undefined;
  let inviteCodeHash: string | undefined;

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
    effectiveGuardianName =
      params.guardianName?.trim() || resolveGuardianName();
    if (
      !effectiveGuardianName ||
      effectiveGuardianName === DEFAULT_USER_REFERENCE ||
      effectiveGuardianName === DECLINED_BY_USER_SENTINEL
    ) {
      return { ok: false, error: "guardianName is required for voice invites" };
    }
    voiceCode = generateVoiceCode(6);
    voiceCodeHash = hashVoiceCode(voiceCode);
  } else {
    inviteCode = generateVoiceCode(6);
    inviteCodeHash = hashVoiceCode(inviteCode);
  }

  const { invite, rawToken } = createInvite({
    sourceChannel: params.sourceChannel,
    contactId: params.contactId,
    note: params.note,
    maxUses: params.maxUses,
    expiresInMs: params.expiresInMs,
    ...(isVoice
      ? {
          expectedExternalUserId: params.expectedExternalUserId,
          voiceCodeHash,
          voiceCodeDigits: 6,
          friendName: params.friendName,
          guardianName: effectiveGuardianName,
        }
      : { inviteCodeHash }),
  });

  // Build invite instruction for non-voice invites via LLM generation
  let guardianInstruction: string | undefined;
  let channelHandle: string | undefined;
  if (!isVoice && inviteCode) {
    const channelId = isChannelId(params.sourceChannel)
      ? params.sourceChannel
      : undefined;
    const adapter = channelId
      ? getInviteAdapterRegistry().get(channelId)
      : undefined;
    if (params.sourceChannel === "telegram") {
      const { ensureTelegramBotUsernameResolved } =
        await import("./channel-invite-transports/telegram.js");
      await ensureTelegramBotUsernameResolved();
    }
    channelHandle = adapter ? await resolveAdapterHandle(adapter) : undefined;
    const share = buildSharePayload(params.sourceChannel, rawToken);
    guardianInstruction = await generateInviteInstruction({
      contactName: params.contactName,
      channelType: params.sourceChannel,
      channelHandle,
      hasShareUrl: !!share?.url,
      shareUrl: share?.url,
    });
  }

  if (isVoice && params.friendName) {
    guardianInstruction = `${params.friendName} will need this code when they answer. Share it with them first.`;
  }

  // Voice invites must not expose the token — callers must redeem via the
  // identity-bound voice code flow, not the generic token redemption path.
  return {
    ok: true,
    data: inviteToResponse(invite, {
      rawToken: isVoice ? undefined : rawToken,
      voiceCode,
      inviteCode,
      guardianInstruction,
      channelHandle,
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

export async function triggerInviteCall(
  inviteId: string,
): Promise<IngressResult<{ callSid: string }>> {
  if (!inviteId) return { ok: false, error: "inviteId is required" };
  const invite = findById(inviteId);
  if (!invite) return { ok: false, error: "Invite not found" };
  if (invite.status !== "active")
    return { ok: false, error: "Invite is not active" };
  if (invite.expiresAt && invite.expiresAt <= Date.now()) {
    markInviteExpired(invite.id);
    return { ok: false, error: "Invite has expired" };
  }
  if (invite.sourceChannel !== "phone")
    return { ok: false, error: "Only phone invites support call triggering" };
  if (
    !invite.expectedExternalUserId ||
    !invite.friendName ||
    !invite.guardianName
  ) {
    return { ok: false, error: "Invite is missing required voice metadata" };
  }
  const result = await startInviteCall({
    phoneNumber: invite.expectedExternalUserId,
    friendName: invite.friendName,
    guardianName: invite.guardianName,
  });
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, data: { callSid: result.callSid } };
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
  sourceChannel: "phone";
  code: string;
}): VoiceRedemptionOutcome {
  return redeemVoiceInviteCodeTyped(params);
}
