/**
 * Inbound payload persistence stage: persists the raw inbound payload and
 * records a conversation-seen signal for Telegram messages.
 *
 * Extracted from inbound-message-handler.ts to keep the top-level handler
 * focused on orchestration.
 */
import type { ChannelId } from "../../../channels/types.js";
import type { TrustContext } from "../../../daemon/conversation-runtime-assembly.js";
import { recordConversationSeenSignal } from "../../../memory/conversation-attention-store.js";
import * as deliveryCrud from "../../../memory/delivery-crud.js";
import { checkIngressForSecrets } from "../../../security/secret-ingress.js";
import { getLogger } from "../../../util/logger.js";

const log = getLogger("runtime-http");

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SecretIngressCheckParams {
  eventId: string;
  sourceChannel: ChannelId;
  conversationExternalId: string;
  externalMessageId: string;
  conversationId: string;
  content: string | undefined;
  trimmedContent: string;
  attachmentIds: string[] | undefined;
  sourceMetadata: Record<string, unknown> | undefined;
  actorDisplayName: string | undefined;
  actorExternalId: string | undefined;
  actorUsername: string | undefined;
  trustCtx: TrustContext;
  replyCallbackUrl: string | undefined;
  canonicalAssistantId: string;
}

export interface SecretIngressCheckResult {
  blocked: boolean;
  detectedTypes?: string[];
}

/**
 * Persist the raw payload, scan for secrets, and record a Telegram seen signal.
 *
 * Returns `{ blocked: true, detectedTypes }` when the message contains
 * known-format secrets — the caller should skip background dispatch and mark
 * the event as processed (not failed/dead-lettered).
 */
export function runSecretIngressCheck(
  params: SecretIngressCheckParams,
): SecretIngressCheckResult {
  const {
    eventId,
    sourceChannel,
    conversationExternalId,
    externalMessageId,
    conversationId,
    content,
    trimmedContent,
    attachmentIds,
    sourceMetadata,
    actorDisplayName,
    actorExternalId,
    actorUsername,
    trustCtx,
    replyCallbackUrl,
    canonicalAssistantId,
  } = params;

  // Persist the raw payload so dead-lettered events can always be replayed.
  deliveryCrud.storePayload(eventId, {
    sourceChannel,
    externalChatId: conversationExternalId,
    externalMessageId,
    content,
    attachmentIds,
    sourceMetadata,
    senderName: actorDisplayName,
    senderExternalUserId: actorExternalId,
    senderUsername: actorUsername,
    trustCtx,
    replyCallbackUrl,
    assistantId: canonicalAssistantId,
  });

  // ── Secret ingress scan ──
  // Scan trimmedContent (post-transcription) so secrets introduced via
  // transcribed audio are also caught.
  const ingressResult = checkIngressForSecrets(trimmedContent);
  if (ingressResult.blocked) {
    // Clear stored payload to prevent secret-bearing content on disk.
    deliveryCrud.clearPayload(eventId);
    log.warn(
      { eventId, detectedTypes: ingressResult.detectedTypes },
      "Channel message blocked at ingress: secret detected",
    );
    return { blocked: true, detectedTypes: ingressResult.detectedTypes };
  }

  // Record inferred seen signal for non-duplicate Telegram inbound messages
  if (sourceChannel === "telegram") {
    try {
      const msgPreview =
        trimmedContent.length > 80
          ? trimmedContent.slice(0, 80) + "..."
          : trimmedContent;
      const evidence =
        trimmedContent.length > 0
          ? `User sent message: '${msgPreview}'`
          : "User sent media attachment";
      recordConversationSeenSignal({
        conversationId,
        signalType: "telegram_inbound_message",
        confidence: "inferred",
        sourceChannel: "telegram",
        source: "inbound-message-handler",
        evidenceText: evidence,
      });
    } catch (err) {
      log.warn(
        { err, conversationId },
        "Failed to record seen signal for Telegram inbound message",
      );
    }
  }

  return { blocked: false };
}
