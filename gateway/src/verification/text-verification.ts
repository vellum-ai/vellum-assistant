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
 *   5. Consume session (dual-write, atomic status guard)
 *   6. Apply side effects (guardian binding OR trusted contact upsert)
 *   7. Deliver deterministic reply
 *
 * The assistant NEVER sees verification code messages. Both success and
 * failure are short-circuited at the gateway.
 */

import { createGuardianBinding } from "../auth/guardian-bootstrap.js";
import { getLogger } from "../logger.js";

import {
  getExistingGuardianBinding,
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
  gatewayChannelStatus,
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
import {
  consumeSession,
  findSessionByHash,
  hasPendingOrActiveSession,
} from "./session-helpers.js";

const log = getLogger("text-verification");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TextVerificationInterceptParams {
  sourceChannel: string;
  messageContent: string;
  actorExternalUserId: string;
  actorChatId: string;
  actorDisplayName?: string;
  actorUsername?: string;
  replyCallbackUrl?: string;
  assistantId?: string;
}

export type TextVerificationResult =
  | { intercepted: false }
  | {
      intercepted: true;
      outcome: "verified" | "failed";
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
  const hasSessions = await hasPendingOrActiveSession(sourceChannel);
  if (!hasSessions) {
    return { intercepted: false };
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
  const session = await findSessionByHash(sourceChannel, challengeHash);

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
  const consumed = await consumeSession(
    session.id,
    canonicalUserId,
    actorChatId,
  );
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
  //    the verification: the actor must not regain trusted status nor see a
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
      "Verification rejected: authoritative gateway channel is blocked/revoked",
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
      replyCallbackUrl,
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

  // Check for binding conflict — another user already holds guardian
  const existing = await getExistingGuardianBinding(sourceChannel);
  if (existing?.address && existing.address !== canonicalUserId) {
    log.warn(
      {
        sourceChannel,
        existingGuardian: existing.address,
        newActor: canonicalUserId,
      },
      "Guardian binding conflict: another user already holds this channel",
    );
    // Still upsert the contact channel so the sender is a known contact,
    // but skip guardian binding creation.
    const { verified } = await upsertVerifiedContactChannel({
      sourceChannel,
      externalUserId: canonicalUserId,
      externalChatId: actorChatId,
      displayName: actorDisplayName,
      username: actorUsername,
    });
    return verified;
  }

  // The gateway is the source of truth: a blocked/revoked gateway row rejects
  // the binding. Check BEFORE the same-user revoke below so a legitimately
  // re-verifying guardian (whose current row is active) isn't blocked by their
  // own about-to-be-revoked row. createGuardianBinding writes "active"
  // unconditionally, so this guard is the only thing stopping a blocked actor.
  const gwStatus = gatewayChannelStatus(sourceChannel, canonicalUserId);
  if (gwStatus === "blocked" || gwStatus === "revoked") {
    log.warn(
      { sourceChannel, address: canonicalUserId, status: gwStatus },
      "Skipping guardian binding: authoritative gateway channel is blocked or revoked",
    );
    return false;
  }

  // Revoke existing binding (same-user re-verification)
  await revokeExistingChannelGuardian(sourceChannel);

  // Resolve canonical principal — unify all channel bindings
  const canonicalPrincipal = await resolveCanonicalPrincipal(canonicalUserId);

  // Determine display name — preserve existing if user is re-verifying
  const existingContact = await findContactChannelByAddress(
    sourceChannel,
    canonicalUserId,
  );
  const displayName = existingContact?.displayName?.trim().length
    ? existingContact.displayName
    : (actorDisplayName ?? actorUsername ?? canonicalUserId);

  // Create guardian binding (dual-writes to both DBs)
  await createGuardianBinding({
    channel: sourceChannel,
    externalUserId: canonicalUserId,
    deliveryChatId: actorChatId,
    guardianPrincipalId: canonicalPrincipal,
    displayName,
    verifiedVia: "challenge",
  });
  return true;
}

async function applyTrustedContactSideEffects(params: {
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
    replyCallbackUrl,
    chatId,
    text,
    assistantId,
  });
  return undefined;
}
