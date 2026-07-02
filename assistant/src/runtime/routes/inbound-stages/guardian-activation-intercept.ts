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
import type {
  CreateOutboundSessionResult,
  VerificationSessionWire,
} from "../../../channels/gateway-verification-sessions.js";
import {
  createOutboundSession,
  findActiveSession,
} from "../../../channels/gateway-verification-sessions.js";
import type { ChannelId } from "../../../channels/types.js";
import {
  getGuardianDeliveryFresh,
  guardianForChannel,
} from "../../../contacts/guardian-delivery-reader.js";
import { emitNotificationSignal } from "../../../notifications/emit-signal.js";
import { getLogger } from "../../../util/logger.js";
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
  sourceMetadata: import("@vellumai/gateway-client").SourceMetadata | undefined;
  replyCallbackUrl: string | undefined;
  assistantId: string;
  externalMessageId: string;
}

/**
 * Lightweight dedup set for guardian activation intercepts.
 * Prevents duplicate replies when Telegram retries the same webhook.
 * Entries are evicted after DEDUP_TTL_MS to avoid unbounded growth.
 */
const DEDUP_TTL_MS = 60_000;
const processedMessageIds = new Map<string, number>();

function isAlreadyProcessed(messageId: string): boolean {
  const now = Date.now();
  // Evict stale entries
  for (const [key, ts] of processedMessageIds) {
    if (now - ts > DEDUP_TTL_MS) processedMessageIds.delete(key);
  }
  return processedMessageIds.has(messageId);
}

function markProcessed(messageId: string): void {
  processedMessageIds.set(messageId, Date.now());
}

export async function handleGuardianActivationIntercept(
  params: GuardianActivationInterceptParams,
): Promise<Record<string, unknown> | null> {
  const {
    sourceChannel,
    conversationExternalId,
    rawSenderId,
    actorDisplayName,
    actorUsername,
    sourceMetadata,
    replyCallbackUrl,
    assistantId,
    externalMessageId,
  } = params;

  // ── Extract commandIntent ──
  const commandIntent = sourceMetadata?.commandIntent;

  // Only proceed for /start commands
  if (!commandIntent || commandIntent.type !== "start") return null;

  // If /start has a payload (e.g. gv_token, iv_token), let the existing
  // bootstrap/invite handlers deal with it.
  if (commandIntent.payload && commandIntent.payload.length > 0) {
    return null;
  }

  // Only proceed for Telegram (can be extended later)
  if (sourceChannel !== "telegram") return null;

  // If a guardian already exists for this channel, continue to normal flow.
  // Null-list (gateway unreachable) is treated as guardian-present so a
  // transient miss does NOT spuriously auto-start verification.
  // Read fresh: gateway-side binding writes don't invalidate the daemon cache.
  const guardianList = await getGuardianDeliveryFresh({
    channelTypes: [sourceChannel],
  });
  if (guardianList === null || guardianForChannel(guardianList, sourceChannel)) {
    return null;
  }

  // Can't bind a session without sender identity
  if (!rawSenderId) return null;

  // ── Webhook retry dedup ──
  // The intercept runs before recordInbound, so use a lightweight in-memory
  // dedup to prevent duplicate replies when Telegram retries the webhook.
  // Only checked here; marked as processed after successful session creation
  // so transient failures remain retryable.
  if (isAlreadyProcessed(externalMessageId)) {
    return { accepted: true, guardianActivation: true };
  }

  // ── Idempotency: check for an existing active session from this sender ──
  // Sessions live in the gateway. Inbound messages arrive through the
  // gateway, so an unreachable gateway here is a narrow race, not a steady
  // state: skip auto-activation (creating would fail anyway) and let the
  // normal pipeline handle the message.
  let existingSession: VerificationSessionWire | null;
  try {
    existingSession = await findActiveSession(sourceChannel);
  } catch (err) {
    log.warn(
      { err, sourceChannel },
      "Guardian activation: session read failed (gateway unreachable), skipping auto-activation",
    );
    return null;
  }
  if (existingSession) {
    // Only block if the session belongs to the same sender. If a different
    // user triggered the session, let this sender proceed (they'll supersede
    // the stale session via createOutboundSession's revocation logic).
    const sessionOwner =
      existingSession.expectedExternalUserId ?? existingSession.expectedChatId;
    if (
      sessionOwner === rawSenderId ||
      sessionOwner === conversationExternalId
    ) {
      if (replyCallbackUrl) {
        deliverChannelReply(replyCallbackUrl, {
          chatId: conversationExternalId,
          text: "A verification is already in progress. Check your assistant app for the code and enter it here.",
          assistantId,
        }).catch((err) => {
          log.error(
            { err, sourceChannel, conversationExternalId },
            "Failed to deliver guardian activation idempotency reply",
          );
        });
      }
      markProcessed(externalMessageId);
      return { accepted: true, guardianActivationPending: true };
    }
  }

  // ── Create verification session ──
  let sessionResult: CreateOutboundSessionResult;
  try {
    sessionResult = await createOutboundSession({
      channel: sourceChannel,
      expectedExternalUserId: rawSenderId,
      expectedChatId: conversationExternalId,
      identityBindingStatus: "bound",
      destinationAddress: conversationExternalId,
      verificationPurpose: "guardian",
    });
  } catch (err) {
    log.warn(
      { err, sourceChannel },
      "Guardian activation: session creation failed (gateway unreachable), skipping auto-activation",
    );
    return null;
  }

  // Mark as processed only after session creation succeeds so transient
  // failures (e.g. gateway unreachable) remain retryable on the next webhook.
  markProcessed(externalMessageId);

  // ── Send deterministic Telegram reply ──
  if (replyCallbackUrl) {
    deliverChannelReply(replyCallbackUrl, {
      chatId: conversationExternalId,
      text: "Welcome! To verify your identity as guardian, check your assistant app for a verification code and enter it here.",
      assistantId,
    }).catch((err) => {
      log.error(
        { err, sourceChannel, conversationExternalId },
        "Failed to deliver guardian activation welcome reply",
      );
    });
  }

  // ── Emit notification signal to deliver code to macOS app ──
  void emitNotificationSignal({
    sourceEventName: "guardian.channel_activation",
    sourceChannel,
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

  return { accepted: true, guardianActivation: true };
}
