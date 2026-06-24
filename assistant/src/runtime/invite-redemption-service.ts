/**
 * Typed invite redemption engine.
 *
 * Wraps the low-level invite store primitives with channel-scoped enforcement
 * and a discriminated-union outcome type so callers can handle every case
 * deterministically. The raw token is accepted as input but is never logged,
 * persisted, or returned in the outcome.
 */

import {
  getInboundTrustVerdict,
  getPhoneCallerVerdict,
} from "../calls/inbound-trust-reader.js";
import type { ChannelId } from "../channels/types.js";
import { findContactChannel, getContact } from "../contacts/contact-store.js";
import { upsertContactChannel } from "../contacts/contacts-write.js";
import type { ChannelStatus } from "../contacts/types.js";
import { ipcCallPersistent } from "../ipc/gateway-client.js";
import { getSqlite } from "../memory/db-connection.js";
import {
  findActiveVoiceInvites,
  findByInviteCodeHash,
  findByTokenHash,
  hashToken,
  markInviteExpired,
  recordInviteUse,
} from "../memory/invite-store.js";
import { canonicalizeInboundIdentity } from "../util/canonicalize-identity.js";
import { getLogger } from "../util/logger.js";
import { hashVoiceCode } from "../util/voice-code.js";
import { verdictMemberFromVerdict } from "./trust-verdict-consumer.js";

const log = getLogger("invite-redemption-service");

/**
 * Resolve the sender's existing member status for the already_member/blocked
 * gate from the gateway trust verdict. Falls back to the local channel status
 * when the verdict is absent or carries no resolvable member status (e.g. an
 * externalChatId-only match or a resolutionFailed verdict), so a locally
 * blocked contact can't bypass the gate.
 */
export async function resolveMemberGateStatus(
  verdict: Awaited<ReturnType<typeof getInboundTrustVerdict>>,
  localChannelStatus: ChannelStatus | null,
): Promise<ChannelStatus | null> {
  const memberStatus = verdict
    ? verdictMemberFromVerdict(verdict)?.status
    : null;
  return memberStatus ?? localChannelStatus;
}

// ---------------------------------------------------------------------------
// Gateway lifecycle bridge (shared by all redemption paths)
// ---------------------------------------------------------------------------
//
// The assistant is the authority on token/code → invite resolution (it holds
// the hashes and caller scoping). Once it has resolved the EXACT invite and
// passed its own validation, it CLAIMS the gateway-canonical row — BY ID, which
// is unambiguous — as the AUTHORITATIVE lifecycle gate BEFORE mutating its own
// DB. `record_invite_redemption` atomically checks status="active" and consumes
// the row, so there is no check-then-act window: a guardian revoke or a racing
// redemption that consumes the gateway row first makes this claim fail, and the
// assistant never mutates. This keeps the gateway invite row the lifecycle
// source of truth across every redemption path (token + 6-digit channel
// intercepts, voice relay, HTTP).

/**
 * Atomically CLAIM the gateway-canonical invite row for `inviteId`.
 *
 * This is the single authoritative gateway gate, performed BEFORE the assistant
 * mutation. Returns a decision the caller maps to behavior:
 *   - "claimed": the gateway row existed and was consumed (active → redeemed) →
 *     proceed to the assistant mutation.
 *   - "rejected": the gateway row EXISTS but was NOT consumable
 *     (revoked / exhausted / expired / already redeemed in a race) → REJECT the
 *     redemption WITHOUT mutating the assistant DB.
 *   - "legacy": no gateway row exists (pre-migration assistant-only invite) →
 *     proceed (the assistant stays authoritative). Logged at warn.
 *   - "unavailable": the gateway IPC threw (gateway unreachable). FAIL-OPEN —
 *     proceed; the assistant-side checks still apply. Logged loudly.
 */
async function claimGatewayRedemption(
  inviteId: string,
  redeemedBy: {
    redeemedByExternalUserId?: string | null;
    redeemedByExternalChatId?: string | null;
  },
): Promise<"claimed" | "rejected" | "legacy" | "unavailable"> {
  try {
    const res = (await ipcCallPersistent("record_invite_redemption", {
      inviteId,
      redeemedByExternalUserId: redeemedBy.redeemedByExternalUserId ?? null,
      redeemedByExternalChatId: redeemedBy.redeemedByExternalChatId ?? null,
    })) as { ok?: boolean; updated?: boolean; mirrored?: boolean } | null;

    if (!res || typeof res !== "object") {
      log.warn(
        { inviteId, res },
        "record_invite_redemption: gateway returned malformed response — failing open",
      );
      return "unavailable";
    }
    if (res.mirrored === false) {
      log.warn(
        { inviteId },
        "record_invite_redemption: no gateway invite row — treating as legacy assistant-only invite",
      );
      return "legacy";
    }
    // mirrored === true: a gateway row exists. `updated` reflects whether the
    // atomic status="active" claim consumed it.
    return res.updated ? "claimed" : "rejected";
  } catch (err) {
    // FAIL-OPEN: availability > strict gating. The assistant-side validation
    // (status/expiry/use-count/channel) still applies; we just couldn't claim
    // the gateway-canonical row.
    log.error(
      { err, inviteId },
      "record_invite_redemption: gateway claim unavailable — failing open (assistant-side checks still apply)",
    );
    return "unavailable";
  }
}

// ---------------------------------------------------------------------------
// Outcome type
// ---------------------------------------------------------------------------

export type InviteRedemptionOutcome =
  | { ok: true; type: "redeemed"; memberId: string; inviteId: string }
  | { ok: true; type: "already_member"; memberId: string }
  | {
      ok: false;
      reason:
        | "invalid_token"
        | "expired"
        | "revoked"
        | "max_uses_reached"
        | "channel_mismatch"
        | "missing_identity";
    };

// Generic failure reasons for voice redemption — intentionally vague to avoid
// leaking information about which invites exist or which identity is bound.
export type VoiceRedemptionOutcome =
  | { ok: true; type: "redeemed"; memberId: string; inviteId: string }
  | { ok: true; type: "already_member"; memberId: string }
  | { ok: false; reason: "invalid_or_expired" };

// ---------------------------------------------------------------------------
// Error-string to typed-reason mapping
// ---------------------------------------------------------------------------

const STORE_ERROR_TO_REASON: Record<
  string,
  (InviteRedemptionOutcome & { ok: false }) | undefined
> = {
  invite_not_found: { ok: false, reason: "invalid_token" },
  invite_expired: { ok: false, reason: "expired" },
  invite_revoked: { ok: false, reason: "revoked" },
  invite_redeemed: { ok: false, reason: "max_uses_reached" },
  invite_max_uses_reached: { ok: false, reason: "max_uses_reached" },
  invite_channel_mismatch: { ok: false, reason: "channel_mismatch" },
};

// ---------------------------------------------------------------------------
// redeemInvite
// ---------------------------------------------------------------------------

export async function redeemInvite(params: {
  rawToken: string;
  sourceChannel: string;
  externalUserId?: string;
  externalChatId?: string;
  displayName?: string;
  username?: string;
  assistantId?: string;
}): Promise<InviteRedemptionOutcome> {
  const {
    rawToken,
    sourceChannel,
    externalUserId,
    externalChatId,
    displayName,
    username,
  } = params;

  if (!externalUserId && !externalChatId) {
    return { ok: false, reason: "missing_identity" };
  }

  // Validate the invite token before any membership checks to prevent
  // membership-status probing with arbitrary tokens.
  const tokenHash = hashToken(rawToken);
  const invite = findByTokenHash(tokenHash);

  if (!invite) {
    return { ok: false, reason: "invalid_token" };
  }

  if (invite.status !== "active") {
    const mapped = STORE_ERROR_TO_REASON[`invite_${invite.status}`];
    if (mapped) return mapped;
    return { ok: false, reason: "invalid_token" };
  }

  if (invite.expiresAt <= Date.now()) {
    markInviteExpired(invite.id);
    return { ok: false, reason: "expired" };
  }

  if (invite.useCount >= invite.maxUses) {
    return { ok: false, reason: "max_uses_reached" };
  }

  // Enforce channel match: the token must belong to the channel the caller
  // is redeeming from.
  if (sourceChannel !== invite.sourceChannel) {
    return { ok: false, reason: "channel_mismatch" };
  }

  // Token is valid — now safe to check existing membership without leaking
  // membership status to callers with bogus tokens.
  const canonicalUserId = externalUserId
    ? (canonicalizeInboundIdentity(
        sourceChannel as ChannelId,
        externalUserId,
      ) ?? externalUserId)
    : undefined;
  const contactResult = findContactChannel({
    channelType: sourceChannel,
    address: canonicalUserId,
    externalChatId: externalChatId,
  });
  const existingChannel = contactResult?.channel ?? null;
  const existingContact = contactResult?.contact ?? null;

  // If the invite targets a specific contact and the sender's existing channel
  // belongs to a different contact, ignore the existing match — the invite
  // should bind the sender's identity to the target contact, not the existing one.
  const targetMismatch =
    existingContact && existingContact.id !== invite.contactId;

  const gateStatus = await resolveMemberGateStatus(
    await getInboundTrustVerdict({
      channelType: sourceChannel as ChannelId,
      actorExternalId: canonicalUserId,
    }),
    existingChannel?.status ?? null,
  );

  if (existingChannel && gateStatus === "active" && !targetMismatch) {
    return { ok: true, type: "already_member", memberId: existingChannel.id };
  }

  // Blocked members cannot bypass the guardian's explicit block via invite
  // links. Return the same generic failure as an invalid token to avoid
  // leaking membership status to the caller.
  if (existingChannel && gateStatus === "blocked") {
    return { ok: false, reason: "invalid_token" };
  }

  // Authoritative gateway claim (by id — caller-scoped resolution already
  // picked the exact invite). Consume the gateway-canonical row BEFORE mutating
  // the assistant so a concurrent revoke/redemption that consumes it first
  // rejects here, with no assistant mutation to roll back. No use is consumed
  // for the already_member/blocked early returns above.
  if (
    (await claimGatewayRedemption(invite.id, {
      redeemedByExternalUserId: externalUserId,
      redeemedByExternalChatId: externalChatId,
    })) === "rejected"
  ) {
    return { ok: false, reason: "invalid_token" };
  }

  // Inactive member reactivation: when the user already has a member record
  // in a non-active state (revoked/pending), reactivate it via upsertContactChannel
  // and consume an invite use atomically. The fresh-member path below also
  // uses upsertContactChannel to keep contacts in sync.
  if (existingChannel && !targetMismatch) {
    // Sentinel error used to trigger a transaction rollback when the invite
    // was concurrently revoked/expired between pre-validation and write time.
    const STALE_INVITE = Symbol("stale_invite");
    const canonicalMemberId = existingChannel.address;
    const canonicalCallerId = externalUserId
      ? canonicalizeInboundIdentity(sourceChannel as ChannelId, externalUserId)
      : null;
    const memberMatchesSender =
      !!canonicalCallerId && canonicalMemberId === canonicalCallerId;
    const preservedDisplayName =
      memberMatchesSender && existingContact?.displayName?.trim().length
        ? existingContact.displayName
        : displayName;

    let reactivated: ReturnType<typeof upsertContactChannel> | undefined;
    try {
      getSqlite()
        .transaction(() => {
          reactivated = upsertContactChannel({
            sourceChannel,
            externalUserId,
            externalChatId,
            // Reactivation should not overwrite a guardian-managed nickname.
            displayName: preservedDisplayName,
            username,
            role: "contact",
            status: "active",
            policy: "allow",
            inviteId: invite.id,
            verifiedAt: Date.now(),
            verifiedVia: "invite",
            contactId: invite.contactId,
          });

          const recorded = recordInviteUse({
            inviteId: invite.id,
            externalUserId,
            externalChatId,
          });

          // If the invite was revoked/expired between pre-validation and this
          // write, recordInviteUse returns false — throw to roll back the
          // member reactivation so the DB stays consistent.
          if (!recorded) throw STALE_INVITE;
        })
        .immediate();
    } catch (err) {
      if (err === STALE_INVITE) {
        return { ok: false, reason: "invalid_token" };
      }
      // Rare: the gateway claim already consumed the row but the assistant
      // mutation failed — a recoverable wasted gateway use; no cross-process
      // rollback is attempted.
      log.error(
        { err, inviteId: invite.id },
        "redeemInvite: assistant mutation failed AFTER gateway claim consumed the row (wasted use)",
      );
      throw err;
    }

    return {
      ok: true,
      type: "redeemed",
      memberId: reactivated!.channel.id,
      inviteId: invite.id,
    };
  }

  // Fresh member creation: upsert into contacts tables and consume an invite
  // use atomically, mirroring the reactivation path above.
  // When the invite targets a specific contact (targetMismatch path), preserve
  // the target contact's guardian-assigned display name if it has one.
  let freshDisplayName = displayName;
  if (invite.contactId) {
    const targetContact = getContact(invite.contactId);
    if (targetContact?.displayName?.trim().length) {
      freshDisplayName = targetContact.displayName;
    }
  }

  const STALE_INVITE_FRESH = Symbol("stale_invite_fresh");
  let freshResult: ReturnType<typeof upsertContactChannel> | undefined;
  try {
    getSqlite()
      .transaction(() => {
        freshResult = upsertContactChannel({
          sourceChannel,
          externalUserId,
          externalChatId,
          displayName: freshDisplayName,
          username,
          role: "contact",
          status: "active",
          policy: "allow",
          inviteId: invite.id,
          verifiedAt: Date.now(),
          verifiedVia: "invite",
          contactId: invite.contactId,
        });

        const recorded = recordInviteUse({
          inviteId: invite.id,
          externalUserId,
          externalChatId,
        });

        if (!recorded) throw STALE_INVITE_FRESH;
      })
      .immediate();
  } catch (err) {
    if (err === STALE_INVITE_FRESH) {
      return { ok: false, reason: "invalid_token" };
    }
    // Rare: gateway claim succeeded but the assistant mutation failed — a
    // recoverable wasted gateway use; no cross-process rollback attempted.
    log.error(
      { err, inviteId: invite.id },
      "redeemInvite: assistant mutation failed AFTER gateway claim consumed the row (wasted use)",
    );
    throw err;
  }

  return {
    ok: true,
    type: "redeemed",
    memberId: freshResult!.channel.id,
    inviteId: invite.id,
  };
}

// ---------------------------------------------------------------------------
// redeemVoiceInviteCode
// ---------------------------------------------------------------------------

/**
 * Redeem a voice invite code for a caller identified by their E.164 phone number.
 *
 * Unlike token-based redemption, voice redemption:
 *   1. Filters only active voice invites bound to the caller's identity
 *      (expectedExternalUserId must match callerExternalUserId).
 *   2. Validates the short numeric code by hashing it and comparing to the
 *      stored voiceCodeHash.
 *   3. Enforces expiry and use limits.
 *   4. On success: upserts/reactivates a member with status 'active', policy 'allow'.
 *   5. Consumes one invite use atomically (increment useCount).
 *
 * Failure responses are intentionally generic ("invalid_or_expired") to prevent
 * oracle attacks that could reveal which invites exist or which phone numbers
 * are bound.
 */
export async function redeemVoiceInviteCode(params: {
  assistantId?: string;
  callerExternalUserId: string;
  sourceChannel: "phone";
  code: string;
}): Promise<VoiceRedemptionOutcome> {
  const { callerExternalUserId, code } = params;

  if (!callerExternalUserId) {
    return { ok: false, reason: "invalid_or_expired" };
  }

  // Find all active voice invites bound to the caller's phone number
  const candidates = findActiveVoiceInvites({
    expectedExternalUserId: callerExternalUserId,
  });

  if (candidates.length === 0) {
    return { ok: false, reason: "invalid_or_expired" };
  }

  const codeHash = hashVoiceCode(code);
  const now = Date.now();

  // Search for a matching invite: code hash match, not expired, uses remaining
  const invite = candidates.find((inv) => {
    if (inv.voiceCodeHash !== codeHash) return false;
    if (inv.expiresAt <= now) return false;
    if (inv.useCount >= inv.maxUses) return false;
    return true;
  });

  if (!invite) {
    // Mark any expired candidates while we're here
    for (const inv of candidates) {
      if (inv.expiresAt <= now && inv.status === "active") {
        markInviteExpired(inv.id);
      }
    }
    return { ok: false, reason: "invalid_or_expired" };
  }

  // Channel enforcement: voice invites can only be redeemed on the voice channel
  if (invite.sourceChannel !== "phone") {
    return { ok: false, reason: "invalid_or_expired" };
  }

  // Check for existing membership
  const canonicalCallerId =
    canonicalizeInboundIdentity("phone" as ChannelId, callerExternalUserId) ??
    callerExternalUserId;
  const voiceContactResult = findContactChannel({
    channelType: "phone",
    address: canonicalCallerId,
  });
  const existingVoiceChannel = voiceContactResult?.channel ?? null;
  const voiceContact = voiceContactResult?.contact ?? null;

  // If the invite targets a specific contact and the sender's existing channel
  // belongs to a different contact, ignore the existing match — the invite
  // should bind the sender's identity to the target contact, not the existing one.
  const targetMismatch = voiceContact && voiceContact.id !== invite.contactId;

  const gateStatus = await resolveMemberGateStatus(
    await getPhoneCallerVerdict(canonicalCallerId),
    existingVoiceChannel?.status ?? null,
  );

  if (existingVoiceChannel && gateStatus === "active" && !targetMismatch) {
    return {
      ok: true,
      type: "already_member",
      memberId: existingVoiceChannel.id,
    };
  }

  // Blocked members cannot bypass the guardian's explicit block
  if (existingVoiceChannel && gateStatus === "blocked") {
    return { ok: false, reason: "invalid_or_expired" };
  }

  // Authoritative gateway claim (by id). The candidate was already resolved
  // caller-scoped (expectedExternalUserId == caller), so the id is unambiguous
  // even when two phone invites share a 6-digit code — this closes the
  // colliding-code gap that a code-hash-only gateway gate left open. Consuming
  // the gateway row here, before the assistant mutation, closes the TOCTOU
  // window: a concurrent revoke/redemption rejects with no assistant mutation.
  if (
    (await claimGatewayRedemption(invite.id, {
      redeemedByExternalUserId: callerExternalUserId,
    })) === "rejected"
  ) {
    return { ok: false, reason: "invalid_or_expired" };
  }

  // Atomic redemption: upsert member + consume invite use in a transaction
  const STALE_INVITE = Symbol("stale_invite");
  let memberId: string | undefined;

  // When the invite targets a specific contact, preserve the target contact's
  // guardian-assigned display name if it has one.
  let preservedDisplayName = voiceContact?.displayName?.trim().length
    ? voiceContact.displayName
    : (invite.friendName ?? undefined);
  if (invite.contactId) {
    const targetContact = getContact(invite.contactId);
    if (targetContact?.displayName?.trim().length) {
      preservedDisplayName = targetContact.displayName;
    }
  }

  try {
    getSqlite()
      .transaction(() => {
        const writeResult = upsertContactChannel({
          sourceChannel: "phone",
          externalUserId: callerExternalUserId,
          externalChatId: callerExternalUserId,
          displayName: preservedDisplayName,
          role: "contact",
          status: "active",
          policy: "allow",
          inviteId: invite.id,
          verifiedAt: Date.now(),
          verifiedVia: "invite",
          contactId: invite.contactId,
        });
        memberId = writeResult!.channel.id;

        const recorded = recordInviteUse({
          inviteId: invite.id,
          externalUserId: callerExternalUserId,
        });

        if (!recorded) throw STALE_INVITE;
      })
      .immediate();
  } catch (err) {
    if (err === STALE_INVITE) {
      return { ok: false, reason: "invalid_or_expired" };
    }
    // Rare: gateway claim succeeded but the assistant mutation failed — a
    // recoverable wasted gateway use; no cross-process rollback attempted.
    log.error(
      { err, inviteId: invite.id },
      "redeemVoiceInviteCode: assistant mutation failed AFTER gateway claim consumed the row (wasted use)",
    );
    throw err;
  }

  return {
    ok: true,
    type: "redeemed",
    memberId: memberId!,
    inviteId: invite.id,
  };
}

// ---------------------------------------------------------------------------
// redeemInviteByCode
// ---------------------------------------------------------------------------

/**
 * Redeem an invite using a 6-digit invite code (channel-agnostic).
 *
 * Unlike token-based redemption which uses deep links, code redemption works
 * by intercepting bare 6-digit messages on channels with codeRedemptionEnabled.
 * The code is hashed and looked up via `findByInviteCodeHash`.
 *
 * Validation: active status, not expired, uses remaining, channel match.
 * On success: upserts/reactivates a member with status 'active', policy 'allow'.
 */
export async function redeemInviteByCode(params: {
  code: string;
  sourceChannel: string;
  externalUserId?: string;
  externalChatId?: string;
  displayName?: string;
  username?: string;
  assistantId?: string;
}): Promise<InviteRedemptionOutcome> {
  const {
    code,
    sourceChannel,
    externalUserId,
    externalChatId,
    displayName,
    username,
  } = params;

  if (!externalUserId && !externalChatId) {
    return { ok: false, reason: "missing_identity" };
  }

  const codeHash = hashVoiceCode(code);
  const invite = findByInviteCodeHash(codeHash, sourceChannel);

  if (!invite) {
    return { ok: false, reason: "invalid_token" };
  }

  if (invite.status !== "active") {
    const mapped = STORE_ERROR_TO_REASON[`invite_${invite.status}`];
    if (mapped) return mapped;
    return { ok: false, reason: "invalid_token" };
  }

  if (invite.expiresAt <= Date.now()) {
    markInviteExpired(invite.id);
    return { ok: false, reason: "expired" };
  }

  if (invite.useCount >= invite.maxUses) {
    return { ok: false, reason: "max_uses_reached" };
  }

  // Code is valid — now safe to check existing membership without leaking
  // membership status to callers with bogus codes.
  const canonicalUserId = externalUserId
    ? (canonicalizeInboundIdentity(
        sourceChannel as ChannelId,
        externalUserId,
      ) ?? externalUserId)
    : undefined;
  const contactResult = findContactChannel({
    channelType: sourceChannel,
    address: canonicalUserId,
    externalChatId: externalChatId,
  });
  const existingChannel = contactResult?.channel ?? null;
  const existingContact = contactResult?.contact ?? null;

  // If the invite targets a specific contact and the sender's existing channel
  // belongs to a different contact, ignore the existing match — the invite
  // should bind the sender's identity to the target contact, not the existing one.
  const targetMismatch =
    existingContact && existingContact.id !== invite.contactId;

  const gateStatus = await resolveMemberGateStatus(
    await getInboundTrustVerdict({
      channelType: sourceChannel as ChannelId,
      actorExternalId: canonicalUserId,
    }),
    existingChannel?.status ?? null,
  );

  if (existingChannel && gateStatus === "active" && !targetMismatch) {
    return { ok: true, type: "already_member", memberId: existingChannel.id };
  }

  // Blocked members cannot bypass the guardian's explicit block via invite
  // codes. Return the same generic failure as an invalid token to avoid
  // leaking membership status to the caller.
  if (existingChannel && gateStatus === "blocked") {
    return { ok: false, reason: "invalid_token" };
  }

  // Authoritative gateway claim (by id). Consume the gateway-canonical row
  // before mutating the assistant, so a concurrent revoke/redemption that
  // consumes it first rejects here with no assistant mutation to roll back. No
  // use is consumed for the already_member/blocked early returns above.
  if (
    (await claimGatewayRedemption(invite.id, {
      redeemedByExternalUserId: externalUserId,
      redeemedByExternalChatId: externalChatId,
    })) === "rejected"
  ) {
    return { ok: false, reason: "invalid_token" };
  }

  // Inactive member reactivation: reactivate via upsertContactChannel and consume
  // an invite use atomically.
  if (existingChannel && !targetMismatch) {
    const STALE_INVITE_REACTIVATE = Symbol("stale_invite_reactivate");
    const canonicalMemberId = existingChannel.address;
    const canonicalCallerId = externalUserId
      ? canonicalizeInboundIdentity(sourceChannel as ChannelId, externalUserId)
      : null;
    const memberMatchesSender =
      !!canonicalCallerId && canonicalMemberId === canonicalCallerId;
    const preservedDisplayName =
      memberMatchesSender && existingContact?.displayName?.trim().length
        ? existingContact.displayName
        : displayName;

    let reactivated: ReturnType<typeof upsertContactChannel> | undefined;
    try {
      getSqlite()
        .transaction(() => {
          reactivated = upsertContactChannel({
            sourceChannel,
            externalUserId,
            externalChatId,
            displayName: preservedDisplayName,
            username,
            role: "contact",
            status: "active",
            policy: "allow",
            inviteId: invite.id,
            verifiedAt: Date.now(),
            verifiedVia: "invite",
            contactId: invite.contactId,
          });

          const recorded = recordInviteUse({
            inviteId: invite.id,
            externalUserId,
            externalChatId,
          });

          if (!recorded) throw STALE_INVITE_REACTIVATE;
        })
        .immediate();
    } catch (err) {
      if (err === STALE_INVITE_REACTIVATE) {
        return { ok: false, reason: "invalid_token" };
      }
      // Rare: gateway claim succeeded but the assistant mutation failed — a
      // recoverable wasted gateway use; no cross-process rollback attempted.
      log.error(
        { err, inviteId: invite.id },
        "redeemInviteByCode: assistant mutation failed AFTER gateway claim consumed the row (wasted use)",
      );
      throw err;
    }

    return {
      ok: true,
      type: "redeemed",
      memberId: reactivated!.channel.id,
      inviteId: invite.id,
    };
  }

  // Fresh member creation: upsert into contacts tables and consume an invite
  // use atomically.
  // When the invite targets a specific contact (targetMismatch path), preserve
  // the target contact's guardian-assigned display name if it has one.
  let freshDisplayName = displayName;
  if (invite.contactId) {
    const targetContact = getContact(invite.contactId);
    if (targetContact?.displayName?.trim().length) {
      freshDisplayName = targetContact.displayName;
    }
  }

  const STALE_INVITE_FRESH = Symbol("stale_invite_fresh");
  let freshResult: ReturnType<typeof upsertContactChannel> | undefined;
  try {
    getSqlite()
      .transaction(() => {
        freshResult = upsertContactChannel({
          sourceChannel,
          externalUserId,
          externalChatId,
          displayName: freshDisplayName,
          username,
          role: "contact",
          status: "active",
          policy: "allow",
          inviteId: invite.id,
          verifiedAt: Date.now(),
          verifiedVia: "invite",
          contactId: invite.contactId,
        });

        const recorded = recordInviteUse({
          inviteId: invite.id,
          externalUserId,
          externalChatId,
        });

        if (!recorded) throw STALE_INVITE_FRESH;
      })
      .immediate();
  } catch (err) {
    if (err === STALE_INVITE_FRESH) {
      return { ok: false, reason: "invalid_token" };
    }
    // Rare: gateway claim succeeded but the assistant mutation failed — a
    // recoverable wasted gateway use; no cross-process rollback attempted.
    log.error(
      { err, inviteId: invite.id },
      "redeemInviteByCode: assistant mutation failed AFTER gateway claim consumed the row (wasted use)",
    );
    throw err;
  }

  return {
    ok: true,
    type: "redeemed",
    memberId: freshResult!.channel.id,
    inviteId: invite.id,
  };
}
