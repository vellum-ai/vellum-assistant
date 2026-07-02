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
  findByTokenHash,
  hashToken,
  type IngressInvite,
} from "../persistence/invite-store.js";
import {
  DECLINED_BY_USER_SENTINEL,
  DEFAULT_USER_REFERENCE,
  resolveGuardianName,
} from "../prompts/user-reference.js";
import {
  getInviteAdapterRegistry,
  resolveAdapterHandle,
} from "./channel-invite-transport.js";
import { generateInviteInstruction } from "./invite-instruction-generator.js";
import { redeemInvite as redeemInviteTyped } from "./invite-redemption-service.js";

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

/**
 * Guardian display label attached to voice invites, resolved from the
 * guardian persona with the placeholder/declined sentinels filtered out.
 * The daemon passes it through to the gateway mint, which stores it on the
 * invite row and never interprets it.
 */
export function resolveInviteGuardianName(): string | undefined {
  const name = resolveGuardianName();
  if (
    !name ||
    name === DEFAULT_USER_REFERENCE ||
    name === DECLINED_BY_USER_SENTINEL
  ) {
    return undefined;
  }
  return name;
}

/**
 * Layer the daemon-owned presentation fields onto a gateway-minted invite
 * payload: the share link, the guardian instruction (LLM-generated for
 * non-voice channels), and the resolved channel handle. The gateway owns the
 * invite row and its secrets; everything added here is display-only, derived
 * from the one-time create response, and never persisted.
 */
export async function composeInvitePresentation(params: {
  contactId?: string;
  invite: Record<string, unknown>;
  rawToken?: string;
}): Promise<Record<string, unknown>> {
  const invite = params.invite;
  const sourceChannel =
    typeof invite.sourceChannel === "string" ? invite.sourceChannel : "";
  const isVoice = sourceChannel === "phone";
  const inviteCode =
    typeof invite.inviteCode === "string" ? invite.inviteCode : undefined;
  if (!isVoice && !inviteCode) {
    return invite;
  }

  // The invitee's name comes from the bound contact's displayName; fall back
  // to the gateway-stamped friendName when the local mirror lacks the contact.
  const boundContact = params.contactId
    ? getContact(params.contactId)
    : undefined;
  const resolvedContactName =
    boundContact?.displayName?.trim() ||
    (typeof invite.friendName === "string"
      ? invite.friendName.trim()
      : undefined) ||
    undefined;

  if (isVoice) {
    const resolvedFirstName = resolvedContactName?.split(/\s+/)[0];
    const guardianInstruction = resolvedFirstName
      ? `${resolvedFirstName} will need this code when they answer. Share it with them first.`
      : "Share this code with them — they'll need it when they answer the call.";
    return { ...invite, guardianInstruction };
  }

  const channelId = isChannelId(sourceChannel) ? sourceChannel : undefined;
  const adapter = channelId
    ? getInviteAdapterRegistry().get(channelId)
    : undefined;
  if (sourceChannel === "telegram") {
    const { ensureTelegramBotUsernameResolved } =
      await import("./channel-invite-transports/telegram.js");
    await ensureTelegramBotUsernameResolved();
  }
  const channelHandle = adapter
    ? await resolveAdapterHandle(adapter)
    : undefined;
  const share = buildSharePayload(sourceChannel, params.rawToken);
  const guardianInstruction = await generateInviteInstruction({
    contactName: resolvedContactName,
    channelType: sourceChannel,
    channelHandle,
    hasShareUrl: !!share?.url,
    shareUrl: share?.url,
  });

  return {
    ...invite,
    ...(share ? { share } : {}),
    ...(guardianInstruction ? { guardianInstruction } : {}),
    ...(channelHandle ? { channelHandle } : {}),
  };
}

/**
 * Place the outbound provider call for a voice invite. Invite lifecycle
 * validation (existence, active status, expiry, phone channel) is the
 * gateway's responsibility — it reads its canonical row and relays the
 * resolved call fields here; the daemon only performs the provider call.
 */
export async function triggerInviteCall(params: {
  phoneNumber?: string;
  friendName?: string | null;
  guardianName?: string | null;
}): Promise<IngressResult<{ callSid: string }>> {
  const phoneNumber = params.phoneNumber?.trim();
  if (!phoneNumber) {
    return { ok: false, error: "phoneNumber is required" };
  }
  // An empty friendName falls through to the neutral "Hi there" greeting
  // downstream rather than substituting the channel address.
  const friendName = params.friendName?.trim() || "";
  // Guardian label is resolved at runtime by the relay; mirror the value
  // into the session so STT hints continue to seed correctly.
  const guardianName = params.guardianName || resolveGuardianName() || "";
  const result = await startInviteCall({
    phoneNumber,
    friendName,
    guardianName,
  });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
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
