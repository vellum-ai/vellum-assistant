/**
 * Secret ingress check stage: persists the raw inbound payload, runs the
 * secret detection scan, and records a conversation-seen signal for
 * Telegram messages.
 *
 * The payload is stored before the scan so dead-lettered events can be
 * replayed. If the scan detects embedded secrets the stored payload is
 * cleared before the IngressBlockedError propagates, ensuring
 * secret-bearing content is never left on disk.
 *
 * Extracted from inbound-message-handler.ts to keep the top-level handler
 * focused on orchestration.
 */
import type { ChannelId } from "../../../channels/types.js";
import type { TrustContext } from "../../../daemon/session-runtime-assembly.js";
import { recordConversationSeenSignal } from "../../../memory/conversation-attention-store.js";
import * as deliveryCrud from "../../../memory/delivery-crud.js";
import { checkIngressForSecrets } from "../../../security/secret-ingress.js";
import { IngressBlockedError } from "../../../util/errors.js";
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

/**
 * Persist the raw payload, run the secret ingress scan, and record a
 * Telegram seen signal.
 *
 * Throws IngressBlockedError if the content contains secrets.
 */
export function runSecretIngressCheck(params: SecretIngressCheckParams): void {
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

  // Persist the raw payload first so dead-lettered events can always be
  // replayed. If the ingress check later detects secrets we clear it
  // before throwing, so secret-bearing content is never left on disk.
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

  const contentToCheck = content ?? "";
  let ingressCheck: ReturnType<typeof checkIngressForSecrets>;
  try {
    ingressCheck = checkIngressForSecrets(contentToCheck);
  } catch (checkErr) {
    deliveryCrud.clearPayload(eventId);
    throw checkErr;
  }
  if (ingressCheck.blocked) {
    deliveryCrud.clearPayload(eventId);
    throw new IngressBlockedError(
      ingressCheck.userNotice!,
      ingressCheck.detectedTypes,
    );
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
}
