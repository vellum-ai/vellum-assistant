/**
 * Gateway-native invite redemption engine + inbound text intercept.
 *
 * Resolves a 6-digit invite code, invite link token, or caller-bound voice
 * code against the gateway-canonical `ingress_invites` table, validates
 * lifecycle (status / expiry / use count / channel), gates on existing gateway
 * membership, claims the row atomically, and applies the verified-channel
 * ACL side effect — entirely inside the gateway. After a successful
 * redemption the daemon is notified best-effort (`invite_redeemed`) so it
 * can mirror the contact info row locally; the mirror never blocks the
 * ACL path.
 *
 * Reply copy mirrors the daemon's invite redemption templates verbatim.
 */

import {
  hashInviteCode,
  hashInviteToken,
  isInviteCodeRedemptionEnabled,
  type ActiveVoiceInvite,
  type CommandIntent,
  type InviteRedemptionOutcome,
  type RedeemInviteByCodeRequest,
  type RedeemInviteByTokenRequest,
  type TrustVerdict,
} from "@vellumai/gateway-client";

import { ContactStore, type IngressInviteRow } from "../db/contact-store.js";
import { ipcCallAssistant } from "../ipc/assistant-client.js";
import { getLogger } from "../logger.js";
import { extractEmailReplyBody } from "./code-parsing.js";
import {
  upsertVerifiedContactChannel,
  getGatewayChannelByExternalChatId,
  getGatewayChannelByKey,
} from "./contact-helpers.js";
import { canonicalizeInboundIdentity } from "./identity.js";
import { ensureInviteLive } from "./invite-liveness.js";
import { deliverVerificationReply } from "./reply-delivery.js";

const log = getLogger("invite-redemption");

// ---------------------------------------------------------------------------
// Reply copy — the canonical user-visible text for invite redemption outcomes.
// ---------------------------------------------------------------------------

const INVITE_REPLY_TEMPLATES = {
  redeemed: "Welcome! You've been granted access.",
  already_member: "You already have access.",
  invalid_token: "This invite is no longer valid.",
  expired: "This invite is no longer valid.",
  revoked: "This invite is no longer valid.",
  max_uses_reached: "This invite is no longer valid.",
  channel_mismatch: "This invite is not valid for this channel.",
  missing_identity:
    "Unable to process this invite. Please contact the person who shared it.",
} as const;

export type InviteRedemptionFailureReason = Exclude<
  keyof typeof INVITE_REPLY_TEMPLATES,
  "redeemed" | "already_member"
>;

// ---------------------------------------------------------------------------
// Engine result
// ---------------------------------------------------------------------------

export type InviteRedemptionEngineResult =
  | {
      status: "redeemed" | "already_member";
      outcome: InviteRedemptionOutcome;
      replyText: string;
    }
  | {
      status: "failed";
      reason: InviteRedemptionFailureReason;
      replyText: string;
    }
  /** Code matched no invite anywhere — the message may be a normal one. */
  | { status: "no_match" };

function failed(
  reason: InviteRedemptionFailureReason,
): InviteRedemptionEngineResult {
  return { status: "failed", reason, replyText: INVITE_REPLY_TEMPLATES[reason] };
}

/** Sender identity fields shared by every redemption path. */
interface RedeemIdentityParams {
  sourceChannel: string;
  externalUserId?: string;
  externalChatId?: string;
  displayName?: string;
  username?: string;
}

// ---------------------------------------------------------------------------
// redeemInviteByCode / redeemInviteByToken
// ---------------------------------------------------------------------------

/**
 * Redeem a 6-digit invite code. The lookup is channel-scoped (small keyspace
 * collides across channels); an active-elsewhere hit yields the
 * channel-mismatch reply WITHOUT consuming a use, and a full miss yields
 * `no_match` so a bare 6-digit message can fall through as normal content.
 */
export async function redeemInviteByCode(
  params: RedeemInviteByCodeRequest & { store?: ContactStore },
): Promise<InviteRedemptionEngineResult> {
  const store = params.store ?? new ContactStore();
  if (!params.externalUserId && !params.externalChatId) {
    return failed("missing_identity");
  }

  const codeHash = hashInviteCode(params.code);
  const invite = store.findInviteByCodeHash(codeHash, params.sourceChannel);
  if (!invite) {
    if (store.findInviteByCodeHashAnyChannel(codeHash)) {
      return failed("channel_mismatch");
    }
    return { status: "no_match" };
  }

  return finishRedemption(store, invite, params);
}

/**
 * Redeem an invite link token (`iv_<token>` deep-link payload). Token hashes
 * are 256-bit and globally unique, so an unmatched token is a definitive
 * invalid invite — never a fall-through.
 */
export async function redeemInviteByToken(
  params: RedeemInviteByTokenRequest & { store?: ContactStore },
): Promise<InviteRedemptionEngineResult> {
  const store = params.store ?? new ContactStore();
  if (!params.externalUserId && !params.externalChatId) {
    return failed("missing_identity");
  }

  const invite = store.findInviteByTokenHash(hashInviteToken(params.token));
  if (!invite) {
    return failed("invalid_token");
  }

  return finishRedemption(store, invite, params);
}

// ---------------------------------------------------------------------------
// Shared validation + claim + ACL side effect
// ---------------------------------------------------------------------------

function reasonForStatus(status: string): InviteRedemptionFailureReason {
  if (status === "expired") return "expired";
  if (status === "revoked") return "revoked";
  if (status === "redeemed") return "max_uses_reached";
  return "invalid_token";
}

async function finishRedemption(
  store: ContactStore,
  invite: IngressInviteRow,
  params: RedeemIdentityParams,
): Promise<InviteRedemptionEngineResult> {
  const { sourceChannel, externalUserId, externalChatId, username } = params;

  const liveness = ensureInviteLive(store, invite);
  if (!liveness.live) {
    return failed(reasonForStatus(liveness.status));
  }
  if (invite.useCount >= invite.maxUses) {
    return failed("max_uses_reached");
  }
  if (invite.sourceChannel !== sourceChannel) {
    return failed("channel_mismatch");
  }

  // ── Membership gate — gateway ACL rows only ──
  // Same (type, address) COLLATE NOCASE resolution the trust-verdict resolver
  // uses; a chatId-only caller falls back to the (type, externalChatId) key so
  // an existing member never consumes a use for lack of an actor external id.
  // `already_member` never consumes a use, and a blocked gateway channel is
  // NEVER reactivated by a code match (generic failure so membership status
  // doesn't leak to callers holding a valid code).
  const canonicalUserId = externalUserId
    ? (canonicalizeInboundIdentity(sourceChannel, externalUserId) ??
      externalUserId)
    : undefined;
  const existing = canonicalUserId
    ? getGatewayChannelByKey(sourceChannel, canonicalUserId)
    : externalChatId
      ? getGatewayChannelByExternalChatId(sourceChannel, externalChatId)
      : null;
  // An existing channel under a different contact is not "already a member"
  // for this invite: the invite binds the sender to its target contact.
  const targetMismatch = !!existing && existing.contactId !== invite.contactId;

  if (existing && existing.status === "active" && !targetMismatch) {
    return {
      status: "already_member",
      outcome: {
        inviteId: invite.id,
        contactId: existing.contactId,
        sourceChannel,
        memberExternalUserId: canonicalUserId ?? existing.address,
        ...(externalChatId ? { memberExternalChatId: externalChatId } : {}),
        result: "already_member",
      },
      replyText: INVITE_REPLY_TEMPLATES.already_member,
    };
  }

  if (existing && existing.status === "blocked") {
    log.warn(
      { sourceChannel, inviteId: invite.id },
      "Invite redemption refused: gateway channel is blocked",
    );
    return failed("invalid_token");
  }

  // ── Atomic claim ──
  // recordInviteRedemption gates on status="active", so only the first of two
  // concurrent redeemers (or a redeemer racing a revoke) consumes the row.
  const claim = store.recordInviteRedemption({
    inviteId: invite.id,
    redeemedByExternalUserId: externalUserId ?? null,
    redeemedByExternalChatId: externalChatId ?? null,
  });
  if (!claim.updated) {
    return failed("invalid_token");
  }

  // ── Commit point ──
  // The claim above consumed the use; from here the redemption must never
  // regress to a thrown engine error (the intercept would fall through and
  // forward the raw code to the runtime on an already-consumed invite).
  // Assistant-mirror failures are soft inside the helper; anything else that
  // throws post-claim is logged and the redemption still succeeds — the
  // daemon `invite_redeemed` event and self-heal cover the mirror.

  // The target contact's curated displayName wins over the raw
  // transport-provided name.
  let displayName = params.displayName;
  try {
    displayName =
      resolveInviteeName(store, invite, params.displayName) ?? undefined;
  } catch (err) {
    log.warn(
      { err, inviteId: invite.id },
      "Invite redemption: target contact lookup failed post-claim",
    );
  }

  // ── ACL side effect ──
  // The same gateway store path the `upsert_verified_channel` IPC handler
  // uses, with the same `allowRevokedReactivation` semantics the daemon's
  // member-write-relay passes: an invite may reactivate a revoked member;
  // blocked actors are still refused inside the helper.
  const address = externalUserId ?? externalChatId!;
  let verified = true;
  try {
    ({ verified } = await upsertVerifiedContactChannel({
      sourceChannel,
      externalUserId: address,
      externalChatId: externalChatId ?? address,
      displayName,
      username,
      verifiedVia: "invite",
      contactId: invite.contactId,
      allowRevokedReactivation: true,
      softMirrorFailures: true,
    }));
  } catch (err) {
    log.error(
      { err, sourceChannel, inviteId: invite.id },
      "Invite redemption: ACL upsert threw post-claim; use already consumed — treating as redeemed",
    );
  }
  if (!verified) {
    // The authoritative write was refused (a block landed under the race).
    // The claimed use is wasted — same semantics as the daemon engine.
    log.warn(
      { sourceChannel, inviteId: invite.id },
      "Invite redemption: gateway channel upsert refused after claim",
    );
    return failed("invalid_token");
  }

  const outcome: InviteRedemptionOutcome = {
    inviteId: invite.id,
    contactId: invite.contactId,
    sourceChannel,
    memberExternalUserId: canonicalUserId ?? address,
    ...(externalChatId ? { memberExternalChatId: externalChatId } : {}),
    ...(displayName ? { displayName } : {}),
    ...(username ? { username } : {}),
    ...(invite.sourceConversationId
      ? { sourceConversationId: invite.sourceConversationId }
      : {}),
    result: "redeemed",
  };
  notifyDaemonInviteRedeemed(outcome);
  return {
    status: "redeemed",
    outcome,
    replyText: INVITE_REPLY_TEMPLATES.redeemed,
  };
}

// ---------------------------------------------------------------------------
// Voice invites (phone channel)
// ---------------------------------------------------------------------------

const DEFAULT_VOICE_CODE_DIGITS = 6;

/** Lazily flip expired-but-still-active candidates to status "expired". */
function sweepExpiredVoiceInvites(
  store: ContactStore,
  candidates: IngressInviteRow[],
  now: number,
): void {
  for (const candidate of candidates) {
    ensureInviteLive(store, candidate, now);
  }
}

/**
 * Resolve an invite's invitee display name: the target contact's curated
 * displayName preferred, the invite's free-text friendName (voice invites)
 * next, then the caller-supplied fallback (e.g. the transport-provided
 * sender name).
 */
export function resolveInviteeName(
  store: ContactStore,
  invite: IngressInviteRow,
  fallback?: string,
): string | null {
  return (
    store.getContact(invite.contactId)?.displayName?.trim() ||
    invite.friendName?.trim() ||
    fallback?.trim() ||
    null
  );
}

/**
 * Resolve the active voice invite awaiting a caller, projected to display
 * metadata for the personalized voice prompt (never the code or its hash).
 * Expired stragglers are lazily swept.
 */
export function getActiveVoiceInviteForCaller(
  callerExternalUserId: string,
  store: ContactStore = new ContactStore(),
): ActiveVoiceInvite | null {
  const candidates = store.findActiveVoiceInvites(callerExternalUserId);
  const now = Date.now();
  sweepExpiredVoiceInvites(store, candidates, now);

  const invite = candidates.find((candidate) => candidate.expiresAt > now);
  if (!invite) return null;

  return {
    inviteId: invite.id,
    inviteeName: resolveInviteeName(store, invite),
    guardianName: invite.guardianName?.trim() || null,
    codeDigits: invite.voiceCodeDigits ?? DEFAULT_VOICE_CODE_DIGITS,
  };
}

export type VoiceInviteRedemptionResult =
  | { status: "redeemed" | "already_member"; outcome: InviteRedemptionOutcome }
  | { status: "failed"; reason: "invalid_or_expired" };

const VOICE_FAILURE: VoiceInviteRedemptionResult = {
  status: "failed",
  reason: "invalid_or_expired",
};

/**
 * Redeem a spoken voice invite code for a caller identified by phone number.
 *
 * Candidates are scoped to active phone invites bound to the caller
 * (`expectedExternalUserId`), then matched by code hash with expiry/use-count
 * pre-checks (expired candidates are lazily swept). Validation, the membership
 * gate (`already_member` no-consume; blocked never reactivated), the atomic
 * claim, and the phone ACL upsert are shared with the code/token paths via
 * {@link finishRedemption} — the invitee display name resolves inside the
 * helper (curated contact name first, invite friendName next).
 *
 * Every failure collapses to the single generic `invalid_or_expired` so a
 * caller probing codes can't learn which invites exist, which numbers are
 * bound, or which check refused them.
 */
export async function redeemVoiceInvite(params: {
  callerExternalUserId: string;
  code: string;
  store?: ContactStore;
}): Promise<VoiceInviteRedemptionResult> {
  const store = params.store ?? new ContactStore();
  const { callerExternalUserId, code } = params;
  if (!callerExternalUserId) return VOICE_FAILURE;

  const candidates = store.findActiveVoiceInvites(callerExternalUserId);
  const codeHash = hashInviteCode(code);
  const now = Date.now();
  const invite = candidates.find(
    (candidate) =>
      candidate.voiceCodeHash === codeHash &&
      candidate.expiresAt > now &&
      candidate.useCount < candidate.maxUses,
  );
  if (!invite) {
    sweepExpiredVoiceInvites(store, candidates, now);
    return VOICE_FAILURE;
  }

  const result = await finishRedemption(store, invite, {
    sourceChannel: "phone",
    externalUserId: callerExternalUserId,
    externalChatId: callerExternalUserId,
  });
  if (result.status !== "redeemed" && result.status !== "already_member") {
    return VOICE_FAILURE;
  }
  return { status: result.status, outcome: result.outcome };
}

// ---------------------------------------------------------------------------
// Daemon info-mirror event (best-effort)
// ---------------------------------------------------------------------------

/**
 * Notify the daemon of a successful redemption so it mirrors the contact
 * info row locally. Fired by {@link finishRedemption} on every `redeemed`
 * outcome (transports only map results to response envelopes).
 * Fire-and-forget: the info mirror must never block or fail the ACL path.
 */
function notifyDaemonInviteRedeemed(outcome: InviteRedemptionOutcome): void {
  void ipcCallAssistant("invite_redeemed", { body: outcome }).catch((err) => {
    log.warn(
      { err, inviteId: outcome.inviteId },
      "invite_redeemed daemon info-mirror failed (best-effort)",
    );
  });
}

// ---------------------------------------------------------------------------
// Inbound text intercept
// ---------------------------------------------------------------------------

const INVITE_TOKEN_PREFIX = "iv_";

/**
 * Extract an invite token from a `/start iv_<token>` deep link. The
 * structured command intent from the gateway's own normalization wins; raw
 * content parsing is the fallback (mirrors the daemon's Telegram adapter).
 */
export function extractInviteToken(
  commandIntent: CommandIntent | undefined,
  content: string,
): string | undefined {
  if (commandIntent?.type === "start") {
    const payload = commandIntent.payload;
    if (payload?.startsWith(INVITE_TOKEN_PREFIX)) {
      const token = payload.slice(INVITE_TOKEN_PREFIX.length);
      if (token.trim().length > 0) return token;
    }
    return undefined;
  }

  const match = content.match(/^\/start\s+iv_(\S+)/);
  return match?.[1] || undefined;
}

export interface InviteRedemptionInterceptParams {
  sourceChannel: string;
  messageContent: string;
  commandIntent?: CommandIntent;
  actorExternalUserId?: string;
  actorChatId: string;
  actorDisplayName?: string;
  actorUsername?: string;
  replyCallbackUrl?: string;
  assistantId?: string;
  /** Resolved gateway trust verdict for the sender (gates to non-members). */
  trustVerdict?: TrustVerdict;
}

export type InviteRedemptionInterceptResult =
  | { intercepted: false }
  | {
      intercepted: true;
      outcome: "redeemed" | "already_member" | "failed";
      /** Reply text when replyCallbackUrl was unavailable (e.g. email). */
      pendingReplyText?: string;
    };

/**
 * Intercept a bare 6-digit invite code or `/start iv_<token>` deep link from
 * a non-member sender and redeem it at the gateway. Called from handleInbound
 * after the verification intercept and trust-verdict resolution.
 *
 * - Only channels in the shared code-redemption allowlist are considered.
 * - Only non-member senders (`unknown` / `unverified_contact`) are
 *   intercepted — a member's bare 6-digit message is a normal message. A
 *   resolution-failure sentinel also falls through (never redeem on a
 *   verdict the resolver could not produce).
 * - A code that matches no invite falls through to normal forwarding; a
 *   matched-but-failed redemption (and a channel mismatch) intercepts with
 *   the deterministic failure reply.
 */
export async function tryInviteRedemptionIntercept(
  params: InviteRedemptionInterceptParams,
): Promise<InviteRedemptionInterceptResult> {
  const {
    sourceChannel,
    messageContent,
    commandIntent,
    actorExternalUserId,
    actorChatId,
    actorDisplayName,
    actorUsername,
    replyCallbackUrl,
    assistantId,
    trustVerdict,
  } = params;

  if (!isInviteCodeRedemptionEnabled(sourceChannel)) {
    return { intercepted: false };
  }

  // For email, strip quoted reply content first (same as the verification
  // intercept) so a bare code isn't buried under signatures/quotes.
  const effectiveContent =
    sourceChannel === "email"
      ? extractEmailReplyBody(messageContent)
      : messageContent;
  const trimmed = effectiveContent.trim();
  const token = extractInviteToken(commandIntent, trimmed);
  const isCode = !token && /^\d{6}$/.test(trimmed);
  if (!token && !isCode) {
    return { intercepted: false };
  }

  // Non-member gate — mirrors the daemon's denyNonMember scope: members
  // (guardian / trusted_contact) are never intercepted.
  const trustClass = trustVerdict?.trustClass;
  if (
    !trustVerdict ||
    trustVerdict.resolutionFailed ||
    (trustClass !== "unknown" && trustClass !== "unverified_contact")
  ) {
    return { intercepted: false };
  }

  let result: InviteRedemptionEngineResult;
  try {
    result = token
      ? await redeemInviteByToken({
          token,
          sourceChannel,
          externalUserId: actorExternalUserId,
          externalChatId: actorChatId,
          displayName: actorDisplayName,
          username: actorUsername,
        })
      : await redeemInviteByCode({
          code: trimmed,
          sourceChannel,
          externalUserId: actorExternalUserId,
          externalChatId: actorChatId,
          displayName: actorDisplayName,
          username: actorUsername,
        });
  } catch (err) {
    // Fail-soft: fall through to normal forwarding rather than dropping the
    // message on an engine error.
    log.error(
      { err, sourceChannel },
      "Invite redemption engine threw — falling through to normal forwarding",
    );
    return { intercepted: false };
  }

  if (result.status === "no_match") {
    return { intercepted: false };
  }

  log.info(
    {
      sourceChannel,
      status: result.status,
      ...(result.status === "failed" ? { reason: result.reason } : {}),
      ...(result.status !== "failed"
        ? { inviteId: result.outcome.inviteId }
        : {}),
    },
    "Invite redemption intercepted at gateway ingress",
  );

  let pendingReplyText: string | undefined;
  if (replyCallbackUrl) {
    await deliverVerificationReply({
      replyCallbackUrl,
      chatId: actorChatId,
      text: result.replyText,
      assistantId,
    });
  } else {
    pendingReplyText = result.replyText;
  }

  return {
    intercepted: true,
    outcome: result.status === "failed" ? "failed" : result.status,
    pendingReplyText,
  };
}
