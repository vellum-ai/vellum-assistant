/**
 * Guardian activation intercept stage: when a bare /start arrives on a
 * Telegram channel with no existing guardian, auto-initiate a verification
 * session so the first user can claim the channel as guardian.
 *
 * This runs BEFORE ACL enforcement — a bare /start from an unknown user
 * would otherwise be rejected. When the user subsequently enters the
 * 6-digit code, the existing verification intercept validates it, creates
 * the guardian binding, and sends a success reply.
 */
import type { ChannelId } from "../../../channels/types.js";
import { findGuardianForChannel } from "../../../contacts/contact-store.js";
import { emitNotificationSignal } from "../../../notifications/emit-signal.js";
import type { NotificationSourceChannel } from "../../../notifications/signal.js";
import { getLogger } from "../../../util/logger.js";
import {
  createOutboundSession,
  findActiveSession,
} from "../../channel-verification-service.js";
import { deliverChannelReply } from "../../gateway-client.js";

const log = getLogger("runtime-http");

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GuardianActivationInterceptParams {
  sourceChannel: ChannelId;
  conversationExternalId: string;
  rawSenderId: string | undefined;
  canonicalSenderId: string | null;
  actorDisplayName: string | undefined;
  actorUsername: string | undefined;
  sourceMetadata: Record<string, unknown> | undefined;
  replyCallbackUrl: string | undefined;
  mintBearerToken: () => string;
  assistantId: string;
}

export async function handleGuardianActivationIntercept(
  params: GuardianActivationInterceptParams,
): Promise<Response | null> {
  const {
    sourceChannel,
    conversationExternalId,
    rawSenderId,
    actorDisplayName,
    actorUsername,
    sourceMetadata,
    replyCallbackUrl,
    mintBearerToken,
    assistantId,
  } = params;

  // ── Extract commandIntent ──
  const rawCommandIntent = sourceMetadata?.commandIntent;
  const commandIntent =
    rawCommandIntent &&
    typeof rawCommandIntent === "object" &&
    !Array.isArray(rawCommandIntent)
      ? (rawCommandIntent as Record<string, unknown>)
      : undefined;

  // Only proceed for /start commands
  if (!commandIntent || commandIntent.type !== "start") return null;

  // If /start has a payload (e.g. gv_token, iv_token), let the existing
  // bootstrap/invite handlers deal with it.
  if (
    typeof commandIntent.payload === "string" &&
    commandIntent.payload.length > 0
  ) {
    return null;
  }

  // Only proceed for Telegram (can be extended later)
  if (sourceChannel !== "telegram") return null;

  // If a guardian already exists for this channel, continue to normal flow
  if (findGuardianForChannel(sourceChannel)) return null;

  // Can't bind a session without sender identity
  if (!rawSenderId) return null;

  // ── Idempotency: check for an existing active session ──
  const existingSession = findActiveSession(sourceChannel);
  if (existingSession) {
    if (replyCallbackUrl) {
      deliverChannelReply(
        replyCallbackUrl,
        {
          chatId: conversationExternalId,
          text: "A verification is already in progress. Check your assistant app for the code and enter it here.",
          assistantId,
        },
        mintBearerToken(),
      ).catch((err) => {
        log.error(
          { err, sourceChannel, conversationExternalId },
          "Failed to deliver guardian activation idempotency reply",
        );
      });
    }
    return Response.json({ accepted: true, guardianActivationPending: true });
  }

  // ── Create verification session ──
  const sessionResult = createOutboundSession({
    channel: sourceChannel,
    expectedExternalUserId: rawSenderId,
    expectedChatId: conversationExternalId,
    identityBindingStatus: "bound",
    destinationAddress: conversationExternalId,
    verificationPurpose: "guardian",
  });

  // ── Send deterministic Telegram reply ──
  if (replyCallbackUrl) {
    deliverChannelReply(
      replyCallbackUrl,
      {
        chatId: conversationExternalId,
        text: "Welcome! To verify your identity as guardian, check your assistant app for a verification code and enter it here.",
        assistantId,
      },
      mintBearerToken(),
    ).catch((err) => {
      log.error(
        { err, sourceChannel, conversationExternalId },
        "Failed to deliver guardian activation welcome reply",
      );
    });
  }

  // ── Emit notification signal to deliver code to macOS app ──
  void emitNotificationSignal({
    sourceEventName: "guardian.channel_activation",
    sourceChannel: sourceChannel as NotificationSourceChannel,
    sourceContextId: `guardian-activation-${sourceChannel}-${rawSenderId}`,
    attentionHints: {
      requiresAction: true,
      urgency: "high",
      isAsyncBackground: false,
      visibleInSourceNow: false,
    },
    contextPayload: {
      verificationCode: sessionResult.secret,
      sourceChannel,
      actorExternalId: rawSenderId,
      actorDisplayName: actorDisplayName ?? null,
      actorUsername: actorUsername ?? null,
      sessionId: sessionResult.sessionId,
      expiresAt: sessionResult.expiresAt,
    },
    dedupeKey: `guardian-activation:${sessionResult.sessionId}`,
  });

  return Response.json({ accepted: true, guardianActivation: true });
}
