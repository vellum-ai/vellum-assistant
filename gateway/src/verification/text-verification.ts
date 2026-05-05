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
import { parseVerificationCode, hashVerificationSecret } from "./code-parsing.js";
import {
  findContactChannelByExternalUserId,
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

  // 1. Parse — only bare 6-digit numeric or 64-char hex codes are intercepted
  const code = parseVerificationCode(messageContent);
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
    await replyWithFailure(
      replyCallbackUrl,
      actorChatId,
      assistantId,
      "The verification code is invalid or has expired.",
    );
    return {
      intercepted: true,
      outcome: "failed",
      trustClass: "guardian",
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
    await replyWithFailure(
      replyCallbackUrl,
      actorChatId,
      assistantId,
      "The verification code is invalid or has expired.",
    );
    return {
      intercepted: true,
      outcome: "failed",
      trustClass: "guardian",
    };
  }

  // 5. Identity binding check (outbound sessions)
  if (!checkIdentityMatch(session, canonicalUserId, actorChatId)) {
    await recordInvalidAttempt(sourceChannel, canonicalUserId, actorChatId);
    log.info(
      { sourceChannel, sessionId: session.id },
      "Verification identity mismatch (anti-oracle: same error as invalid code)",
    );
    await replyWithFailure(
      replyCallbackUrl,
      actorChatId,
      assistantId,
      "The verification code is invalid or has expired.",
    );
    return {
      intercepted: true,
      outcome: "failed",
      trustClass: session.verificationPurpose === "trusted_contact"
        ? "trusted_contact"
        : "guardian",
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
    await replyWithFailure(
      replyCallbackUrl,
      actorChatId,
      assistantId,
      "The verification code is invalid or has expired.",
    );
    return {
      intercepted: true,
      outcome: "failed",
      trustClass: session.verificationPurpose === "trusted_contact"
        ? "trusted_contact"
        : "guardian",
    };
  }

  // Reset rate limits on success
  await resetRateLimit(sourceChannel, canonicalUserId, actorChatId);

  const trustClass: "guardian" | "trusted_contact" =
    session.verificationPurpose === "trusted_contact"
      ? "trusted_contact"
      : "guardian";

  // 7. Apply side effects
  if (trustClass === "guardian") {
    await applyGuardianSideEffects({
      sourceChannel,
      canonicalUserId,
      actorChatId,
      actorDisplayName,
      actorUsername,
    });
  } else {
    await applyTrustedContactSideEffects({
      sourceChannel,
      canonicalUserId,
      actorChatId,
      actorDisplayName,
      actorUsername,
    });
  }

  // 8. Deliver success reply
  if (replyCallbackUrl) {
    const replyText = composeVerificationSuccessReply(trustClass);
    await deliverVerificationReply({
      replyCallbackUrl,
      chatId: actorChatId,
      text: replyText,
      assistantId,
    });
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

  return { intercepted: true, outcome: "verified", trustClass };
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
}): Promise<void> {
  const {
    sourceChannel,
    canonicalUserId,
    actorChatId,
    actorDisplayName,
    actorUsername,
  } = params;

  // Check for binding conflict — another user already holds guardian
  const existing = await getExistingGuardianBinding(sourceChannel);
  if (existing?.externalUserId && existing.externalUserId !== canonicalUserId) {
    log.warn(
      {
        sourceChannel,
        existingGuardian: existing.externalUserId,
        newActor: canonicalUserId,
      },
      "Guardian binding conflict: another user already holds this channel",
    );
    // Still upsert the contact channel so the sender is a known contact,
    // but skip guardian binding creation.
    await upsertVerifiedContactChannel({
      sourceChannel,
      externalUserId: canonicalUserId,
      externalChatId: actorChatId,
      displayName: actorDisplayName,
      username: actorUsername,
    });
    return;
  }

  // Revoke existing binding (same-user re-verification)
  await revokeExistingChannelGuardian(sourceChannel);

  // Resolve canonical principal — unify all channel bindings
  const canonicalPrincipal = await resolveCanonicalPrincipal(canonicalUserId);

  // Determine display name — preserve existing if user is re-verifying
  const existingContact = await findContactChannelByExternalUserId(
    sourceChannel,
    canonicalUserId,
  );
  const displayName =
    existingContact?.displayName?.trim().length
      ? existingContact.displayName
      : actorDisplayName ?? actorUsername ?? canonicalUserId;

  // Create guardian binding (dual-writes to both DBs)
  await createGuardianBinding({
    channel: sourceChannel,
    externalUserId: canonicalUserId,
    deliveryChatId: actorChatId,
    guardianPrincipalId: canonicalPrincipal,
    displayName,
    verifiedVia: "challenge",
  });
}

async function applyTrustedContactSideEffects(params: {
  sourceChannel: string;
  canonicalUserId: string;
  actorChatId: string;
  actorDisplayName?: string;
  actorUsername?: string;
}): Promise<void> {
  const {
    sourceChannel,
    canonicalUserId,
    actorChatId,
    actorDisplayName,
    actorUsername,
  } = params;

  // Preserve existing display name if available
  const existingContact = await findContactChannelByExternalUserId(
    sourceChannel,
    canonicalUserId,
  );
  const displayName =
    existingContact?.displayName?.trim().length
      ? existingContact.displayName
      : actorDisplayName ?? actorUsername ?? canonicalUserId;

  await upsertVerifiedContactChannel({
    sourceChannel,
    externalUserId: canonicalUserId,
    externalChatId: actorChatId,
    displayName,
    username: actorUsername,
  });
}

// ---------------------------------------------------------------------------
// Reply helpers
// ---------------------------------------------------------------------------

async function replyWithFailure(
  replyCallbackUrl: string | undefined,
  chatId: string,
  assistantId: string | undefined,
  reason: string,
): Promise<void> {
  if (!replyCallbackUrl) return;
  const text = composeVerificationFailureReply(reason);
  await deliverVerificationReply({
    replyCallbackUrl,
    chatId,
    text,
    assistantId,
  });
}
