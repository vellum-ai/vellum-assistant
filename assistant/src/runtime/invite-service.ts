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
import { getContact } from "../contacts/contact-store.js";
import {
  createInvite,
  findById,
  findByTokenHash,
  hashToken,
  type IngressInvite,
  markInviteExpired,
} from "../persistence/invite-store.js";
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
  redeemInvite as redeemInviteTyped,
  redeemVoiceInviteCode as redeemVoiceInviteCodeTyped,
  type VoiceRedemptionOutcome,
} from "./invite-redemption-service.js";

// ---------------------------------------------------------------------------
// Response shapes — used by both HTTP routes and message handlers
// ---------------------------------------------------------------------------

/**
 * Redemption outcome type surfaced to callers. `already_member` consumes no
 * invite use, so the gateway must not mirror it into recordInviteRedemption.
 */
export type RedemptionType = "redeemed" | "already_member";

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
  // Voice invite parameters. Display metadata is no longer accepted from
  // callers: the invitee's name is resolved from the bound contact's
  // displayName at every read site (voice greeting, instructions), and the
  // guardian label is resolved at runtime via resolveGuardianName().
  expectedExternalUserId?: string;
  contactId: string;
}): Promise<IngressResult<InviteResponseData>> {
  if (!params.sourceChannel) {
    return { ok: false, error: "sourceChannel is required for create" };
  }

  if (!params.contactId) {
    return { ok: false, error: "contactId is required for create" };
  }

  // Resolve the bound contact's displayName as the canonical invitee name.
  // The greeting and instruction copy use this rather than a free-text flag.
  const boundContact = getContact(params.contactId);
  const resolvedContactName = boundContact?.displayName?.trim() || undefined;
  const resolvedFirstName = resolvedContactName?.split(/\s+/)[0];

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
    effectiveGuardianName = resolveGuardianName();
    if (
      !effectiveGuardianName ||
      effectiveGuardianName === DEFAULT_USER_REFERENCE ||
      effectiveGuardianName === DECLINED_BY_USER_SENTINEL
    ) {
      effectiveGuardianName = undefined;
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
          // Mirror the contact-resolved names into the legacy columns so
          // outbound invite calls (which still read invite.friendName /
          // invite.guardianName) keep working without a separate lookup.
          friendName: resolvedContactName,
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
      contactName: resolvedContactName,
      channelType: params.sourceChannel,
      channelHandle,
      hasShareUrl: !!share?.url,
      shareUrl: share?.url,
    });
  }

  if (isVoice) {
    guardianInstruction = resolvedFirstName
      ? `${resolvedFirstName} will need this code when they answer. Share it with them first.`
      : "Share this code with them — they'll need it when they answer the call.";
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

// ---------------------------------------------------------------------------
// Mint — gateway-facing projection
//
// The gateway owns the canonical invite lifecycle in its own DB, but token
// generation/hashing and voice fields are assistant-owned. `mintIngressInvite`
// runs the same `createIngressInvite` path and surfaces the raw token plus the
// minimal projection the gateway mirrors. The raw token is returned exactly
// once and never persisted in plaintext.
// ---------------------------------------------------------------------------

/** Minimal invite projection the gateway mirrors into its own store. */
export interface GatewayInviteProjection {
  id: string;
  /** Hash of whatever code redeems this invite: token hash for token invites,
   * voice code hash for voice/phone invites. Always non-null and mirrorable. */
  inviteCodeHash: string;
  sourceChannel: string;
  contactId: string;
  note: string | null;
  maxUses: number;
  expiresAt: number;
}

export interface MintInviteResult {
  invite: InviteResponseData;
  rawToken?: string;
  gateway: GatewayInviteProjection;
}

export async function mintIngressInvite(
  params: Parameters<typeof createIngressInvite>[0],
): Promise<IngressResult<MintInviteResult>> {
  const result = await createIngressInvite(params);
  if (!result.ok) return result;

  // The persisted row carries fields the response projection omits
  // (inviteCodeHash); read it back to build the gateway projection.
  const row = findById(result.data.id);
  if (!row) {
    return { ok: false, error: "Invite not found after mint" };
  }

  // The gateway mirrors the hash of whatever code redeems this invite. Token
  // invites carry inviteCodeHash; voice/phone invites gate on voiceCodeHash.
  const inviteCodeHash = row.inviteCodeHash ?? row.voiceCodeHash;
  if (!inviteCodeHash) {
    return { ok: false, error: "Invite is missing a redemption code hash" };
  }

  return {
    ok: true,
    data: {
      invite: result.data,
      rawToken: result.data.token,
      gateway: {
        id: row.id,
        inviteCodeHash,
        sourceChannel: row.sourceChannel,
        contactId: row.contactId,
        note: row.note,
        maxUses: row.maxUses,
        expiresAt: row.expiresAt,
      },
    },
  };
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
  if (!invite.expectedExternalUserId) {
    return { ok: false, error: "Invite is missing required voice metadata" };
  }
  // Resolve the invitee's name from the bound contact's displayName.
  // `contact_id` is NOT NULL on the invite row, so every invite is bound;
  // an empty displayName falls through to the neutral "Hi there" greeting
  // downstream rather than a stale free-text `friend_name` label.
  const boundContact = getContact(invite.contactId);
  const friendName = boundContact?.displayName?.trim() || "";
  // Guardian label is resolved at runtime by the relay; mirror the legacy
  // value into the session so STT hints continue to seed correctly.
  const guardianName = invite.guardianName || resolveGuardianName() || "";
  const result = await startInviteCall({
    phoneNumber: invite.expectedExternalUserId,
    friendName,
    guardianName,
  });
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, data: { callSid: result.callSid } };
}

export async function redeemIngressInvite(params: {
  token?: string;
  externalUserId?: string;
  externalChatId?: string;
  sourceChannel?: string;
}): Promise<
  IngressResult<{ invite: InviteResponseData; type: RedemptionType }>
> {
  if (!params.token) {
    return { ok: false, error: "token is required for redeem" };
  }
  if (!params.sourceChannel) {
    return { ok: false, error: "sourceChannel is required for redeem" };
  }
  const outcome = await redeemInviteTyped({
    rawToken: params.token,
    sourceChannel: params.sourceChannel,
    externalUserId: params.externalUserId,
    externalChatId: params.externalChatId,
  });
  if (!outcome.ok) {
    return { ok: false, error: outcome.reason };
  }
  // Look up the invite by token hash for both outcomes (`redeemed` and
  // `already_member`). Using findByTokenHash avoids the pagination limit of
  // listInvites. The `type` is surfaced so the gateway can skip mirroring an
  // `already_member` redemption (which consumes no use).
  const inv = findByTokenHash(hashToken(params.token));
  if (!inv) {
    return { ok: false, error: "Invite not found after redemption" };
  }
  return {
    ok: true,
    data: { invite: inviteToResponse(inv), type: outcome.type },
  };
}

export function redeemVoiceInviteCode(params: {
  assistantId?: string;
  callerExternalUserId: string;
  sourceChannel: "phone";
  code: string;
}): Promise<VoiceRedemptionOutcome> {
  return redeemVoiceInviteCodeTyped(params);
}
