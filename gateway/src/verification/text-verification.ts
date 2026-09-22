/**
 * Gateway-owned text-channel verification intercept.
 *
 * Called from handleInbound before forwardToRuntime. When a message is a
 * bare verification code AND there is a pending/active session for this
 * channel, the gateway handles the entire flow:
 *
 *   1. Parse code from message content
 *   2. Check rate limits
 *   3. Hash + find matching session
 *   4. Verify identity binding (outbound sessions)
 *   5. Consume session (atomic status guard)
 *   6. Apply side effects (guardian binding OR trusted contact upsert)
 *   7. Deliver deterministic reply
 *
 * The assistant NEVER sees verification code messages. Both success and
 * failure are short-circuited at the gateway.
 */

import { createGuardianBinding } from "../auth/guardian-bootstrap.js";
import {
  consumeSession,
  findPendingSessionByHash,
  hasInterceptableSession,
} from "../db/session-store.js";
import { getLogger } from "../logger.js";

import {
  activeGuardianAddresses,
  resolveCanonicalPrincipal,
  revokeExistingChannelGuardian,
} from "./binding-helpers.js";
import {
  extractEmailReplyBody,
  parseVerificationCode,
  hashVerificationSecret,
} from "./code-parsing.js";
import {
  findContactChannelByAddress,
  gatewayChannelRow,
  upsertVerifiedContactChannel,
} from "./contact-helpers.js";
import { canonicalizeInboundIdentity } from "./identity.js";
import { checkIdentityMatch } from "./identity-match.js";
import {
  isRateLimited,
  recordInvalidAttempt,
  resetRateLimit,
} from "./rate-limit-helpers.js";
import {
  composeVerificationFailureReply,
  composeVerificationSuccessReply,
  deliverVerificationReply,
} from "./reply-delivery.js";

const log = getLogger("text-verification");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TextVerificationInterceptParams {
  sourceChannel: string;
  messageContent: string;
  actorExternalUserId: string;
  actorChatId: string;
  /** The wire-proven readership fact, when the channel states one. */
  isDirectMessage?: boolean;
  actorDisplayName?: string;
  actorUsername?: string;
  replyCallbackUrl?: string;
  assistantId?: string;
}

export type TextVerificationResult =
  | { intercepted: false }
  | {
      intercepted: true;
      outcome: "verified" | "failed" | "wrong_conversation";
      trustClass: "guardian" | "trusted_contact";
      /** Reply text when replyCallbackUrl was unavailable (e.g. email channel). */
      pendingReplyText?: string;
    };

// ---------------------------------------------------------------------------
// Main intercept
// ---------------------------------------------------------------------------

export async function tryTextVerificationIntercept(
  params: TextVerificationInterceptParams,
): Promise<TextVerificationResult> {
  const {
    sourceChannel,
    messageContent,
    actorExternalUserId,
    actorChatId,
    isDirectMessage,
    actorDisplayName,
    actorUsername,
    replyCallbackUrl,
    assistantId,
  } = params;

  // 1. Parse — only bare 6-digit numeric or 64-char hex codes are intercepted.
  //    For email, strip quoted reply content first so the code isn't buried
  //    under signatures and quoted thread text.
  const effectiveContent =
    sourceChannel === "email"
      ? extractEmailReplyBody(messageContent)
      : messageContent;
  const code = parseVerificationCode(effectiveContent);
  if (code === undefined) {
    return { intercepted: false };
  }

  // 2. Fast guard — is there any pending session for this channel?
  if (!hasInterceptableSession(sourceChannel)) {
    return { intercepted: false };
  }

  // 2b. Lane guard. A verification code completes only where one reader
  // exists: the copy that carried it said "reply here" in a direct message,
  // and a code posted into a room was already shown to everyone in it. The
  // message is still intercepted, so the code never reaches the assistant
  // or the transcript, but it is never redeemed, and the reply says where
  // to send it without saying whether it was valid. Keyed on the wire's
  // readership fact rather than its visibility axis, because Discord can
  // prove a guild message is not a DM while proving nothing about the
  // room's visibility; a channel that states nothing (or a true DM) is
  // unaffected.
  if (isDirectMessage === false) {
    log.info(
      { sourceChannel },
      "Verification code arrived outside a direct message; not redeemed",
    );
    const pendingReplyText = await replyWithFailure(
      replyCallbackUrl,
      actorChatId,
      assistantId,
      "For security, verification codes only work in a direct message. Send it to me there.",
    );
    return {
      intercepted: true,
      outcome: "wrong_conversation",
      trustClass: "guardian",
      pendingReplyText,
    };
  }

  const canonicalUserId =
    canonicalizeInboundIdentity(sourceChannel, actorExternalUserId) ??
    actorExternalUserId;

  // 3. Rate limit check
  if (isRateLimited(sourceChannel, canonicalUserId, actorChatId)) {
    log.info(
      { sourceChannel, actorExternalUserId: canonicalUserId },
      "Verification attempt rate-limited",
    );
    const pendingReplyText = await replyWithFailure(
      replyCallbackUrl,
      actorChatId,
      assistantId,
      "The verification code is invalid or has expired.",
    );
    return {
      intercepted: true,
      outcome: "failed",
      trustClass: "guardian",
      pendingReplyText,
    };
  }

  // 4. Hash + find session
  const challengeHash = hashVerificationSecret(code);
  const session = findPendingSessionByHash(sourceChannel, challengeHash);

  if (!session) {
    await recordInvalidAttempt(sourceChannel, canonicalUserId, actorChatId);
    log.info(
      { sourceChannel, actorExternalUserId: canonicalUserId },
      "Verification code did not match any pending session",
    );
    const pendingReplyText = await replyWithFailure(
      replyCallbackUrl,
      actorChatId,
      assistantId,
      "The verification code is invalid or has expired.",
    );
    return {
      intercepted: true,
      outcome: "failed",
      trustClass: "guardian",
      pendingReplyText,
    };
  }

  // 5. Identity binding check (outbound sessions)
  if (!checkIdentityMatch(session, canonicalUserId, actorChatId)) {
    await recordInvalidAttempt(sourceChannel, canonicalUserId, actorChatId);
    log.info(
      { sourceChannel, sessionId: session.id },
      "Verification identity mismatch (anti-oracle: same error as invalid code)",
    );
    const pendingReplyText = await replyWithFailure(
      replyCallbackUrl,
      actorChatId,
      assistantId,
      "The verification code is invalid or has expired.",
    );
    return {
      intercepted: true,
      outcome: "failed",
      trustClass:
        session.verificationPurpose === "trusted_contact"
          ? "trusted_contact"
          : "guardian",
      pendingReplyText,
    };
  }

  // 6. Consume session (atomic — only the first consumer wins)
  const { consumed } = consumeSession(session.id, canonicalUserId, actorChatId);
  if (!consumed) {
    log.warn(
      { sessionId: session.id },
      "Session already consumed by concurrent request",
    );
    const pendingReplyText = await replyWithFailure(
      replyCallbackUrl,
      actorChatId,
      assistantId,
      "The verification code is invalid or has expired.",
    );
    return {
      intercepted: true,
      outcome: "failed",
      trustClass:
        session.verificationPurpose === "trusted_contact"
          ? "trusted_contact"
          : "guardian",
      pendingReplyText,
    };
  }

  // Reset rate limits on success
  await resetRateLimit(sourceChannel, canonicalUserId, actorChatId);

  const trustClass: "guardian" | "trusted_contact" =
    session.verificationPurpose === "trusted_contact"
      ? "trusted_contact"
      : "guardian";

  // 7. Apply side effects. A blocked/revoked authoritative gateway row rejects
  //    the verification, and so does a guardian code from an identity other
  //    than the one linked on the channel: the actor must not gain trusted
  //    status nor see a
  //    success reply, even though the code matched and the session consumed.
  const sideEffectsVerified =
    trustClass === "guardian"
      ? await applyGuardianSideEffects({
          sourceChannel,
          canonicalUserId,
          actorChatId,
          actorDisplayName,
          actorUsername,
        })
      : await applyTrustedContactSideEffects({
          sourceChannel,
          canonicalUserId,
          actorChatId,
          actorDisplayName,
          actorUsername,
        });

  if (!sideEffectsVerified) {
    log.warn(
      { sourceChannel, actorExternalUserId: canonicalUserId, trustClass },
      "Verification rejected: the consumed code granted nothing",
    );
    const pendingReplyText = await replyWithFailure(
      replyCallbackUrl,
      actorChatId,
      assistantId,
      "The verification code is invalid or has expired.",
    );
    return {
      intercepted: true,
      outcome: "failed",
      trustClass,
      pendingReplyText,
    };
  }

  // 8. Deliver success reply
  const successReplyText = composeVerificationSuccessReply(trustClass);
  let pendingReplyText: string | undefined;
  if (replyCallbackUrl) {
    await deliverVerificationReply({
      callbackUrl: replyCallbackUrl,
      chatId: actorChatId,
      text: successReplyText,
      assistantId,
    });
  } else {
    pendingReplyText = successReplyText;
  }

  log.info(
    {
      sourceChannel,
      actorExternalUserId: canonicalUserId,
      trustClass,
      sessionId: session.id,
    },
    "Text verification succeeded",
  );

  return {
    intercepted: true,
    outcome: "verified",
    trustClass,
    pendingReplyText,
  };
}

// ---------------------------------------------------------------------------
// Side effects
// ---------------------------------------------------------------------------

async function applyGuardianSideEffects(params: {
  sourceChannel: string;
  canonicalUserId: string;
  actorChatId: string;
  actorDisplayName?: string;
  actorUsername?: string;
}): Promise<boolean> {
  const {
    sourceChannel,
    canonicalUserId,
    actorChatId,
    actorDisplayName,
    actorUsername,
  } = params;

  // The only await before the binding is written, so it runs first. From the
  // refusal check below to the gateway writes inside createGuardianBinding
  // (a synchronous transaction, ahead of that function's own first await)
  // nothing yields, so two codes redeemed at once cannot both pass the check.
  // A sender verifying again keeps the name their contact already has. The
  // read is for that name only: a daemon that cannot answer falls back to the
  // name the channel gave, so no outcome below depends on the daemon.
  let existingContact: Awaited<ReturnType<typeof findContactChannelByAddress>> =
    null;
  try {
    existingContact = await findContactChannelByAddress(
      sourceChannel,
      canonicalUserId,
    );
  } catch (err) {
    log.warn(
      { err, sourceChannel },
      "Guardian display name lookup failed; using the name the channel gave",
    );
  }
  const displayName = existingContact?.displayName?.trim().length
    ? existingContact.displayName
    : (actorDisplayName ?? actorUsername ?? canonicalUserId);

  // The guardian is one person, and a channel holds at most one linked
  // identity for them. A guardian code links an identity where none is linked,
  // or links the same one again. It never swaps one identity for another, and
  // grants nothing in its place: swapping is two explicit acts, remove the
  // link and then connect again. Every active row is read, so a second one is
  // weighed and not hidden behind a LIMIT 1. This is the text-channel rule; an
  // outbound phone code replaces the bound number (session-service.ts).
  const otherLinkedIdentities = activeGuardianAddresses(sourceChannel).filter(
    (address) => address !== canonicalUserId,
  );
  if (otherLinkedIdentities.length > 0) {
    log.warn(
      {
        sourceChannel,
        linkedIdentities: otherLinkedIdentities,
        newActor: canonicalUserId,
      },
      "Guardian code refused: a different identity is linked as the guardian on this channel",
    );
    return false;
  }

  // The gateway is the source of truth: a blocked/revoked gateway row rejects
  // the binding. Check BEFORE the same-user revoke below so a legitimately
  // re-verifying guardian (whose current row is active) isn't blocked by their
  // own about-to-be-revoked row. createGuardianBinding writes "active"
  // unconditionally, so this guard is the only thing stopping a blocked actor.
  //
  // One revoked row gets past it: the guardian's own, on a channel with no
  // other linked identity. That is the guardian linking again the identity
  // they removed. The row has to belong to the guardian contact: a contact the
  // guardian revoked stays revoked whatever code they hold. A blocked row
  // never gets past it.
  const gwRow = gatewayChannelRow(sourceChannel, canonicalUserId);
  const gwStatus = gwRow?.status ?? null;
  if (gwStatus === "blocked" || gwStatus === "revoked") {
    const reconnectsOwnRevokedRow =
      gwStatus === "revoked" &&
      gwRow?.contactRole === "guardian" &&
      gwRow?.address === canonicalUserId &&
      otherLinkedIdentities.length === 0;
    if (!reconnectsOwnRevokedRow) {
      log.warn(
        { sourceChannel, address: canonicalUserId, status: gwStatus },
        "Skipping guardian binding: authoritative gateway channel is blocked or revoked",
      );
      return false;
    }
  }

  // Revoke existing binding (same-user re-verification)
  revokeExistingChannelGuardian(sourceChannel);

  // Resolve canonical principal — unify all channel bindings
  const canonicalPrincipal = resolveCanonicalPrincipal(canonicalUserId);

  // Create guardian binding (dual-writes to both DBs)
  await createGuardianBinding({
    channel: sourceChannel,
    externalUserId: canonicalUserId,
    deliveryChatId: actorChatId,
    guardianPrincipalId: canonicalPrincipal,
    displayName,
    verifiedVia: "challenge",
    reactivateRevoked: true,
  });
  return true;
}

/**
 * Trusted-contact side effect for a consumed verification session:
 * idempotent verified-channel upsert. Shared with the session service's
 * validate+consume path so the write has exactly one implementation.
 * Returns false when the authoritative gateway row is blocked/revoked.
 */
export async function applyTrustedContactSideEffects(params: {
  sourceChannel: string;
  canonicalUserId: string;
  actorChatId: string;
  actorDisplayName?: string;
  actorUsername?: string;
}): Promise<boolean> {
  const {
    sourceChannel,
    canonicalUserId,
    actorChatId,
    actorDisplayName,
    actorUsername,
  } = params;

  // Preserve existing display name if available
  const existingContact = await findContactChannelByAddress(
    sourceChannel,
    canonicalUserId,
  );
  const displayName = existingContact?.displayName?.trim().length
    ? existingContact.displayName
    : (actorDisplayName ?? actorUsername ?? canonicalUserId);

  const { verified } = await upsertVerifiedContactChannel({
    sourceChannel,
    externalUserId: canonicalUserId,
    externalChatId: actorChatId,
    displayName,
    username: actorUsername,
  });
  return verified;
}

// ---------------------------------------------------------------------------
// Reply helpers
// ---------------------------------------------------------------------------

async function replyWithFailure(
  replyCallbackUrl: string | undefined,
  chatId: string,
  assistantId: string | undefined,
  reason: string,
): Promise<string | undefined> {
  const text = composeVerificationFailureReply(reason);
  if (!replyCallbackUrl) return text;
  await deliverVerificationReply({
    callbackUrl: replyCallbackUrl,
    chatId,
    text,
    assistantId,
  });
  return undefined;
}
