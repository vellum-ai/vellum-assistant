/**
 * Periodic retry sweep for failed channel inbound events.
 */

import {
  isChannelId,
  parseChannelId,
  parseInterfaceId,
} from "../channels/types.js";
import type { TrustContext } from "../daemon/session-runtime-assembly.js";
import * as deliveryChannels from "../memory/delivery-channels.js";
import * as deliveryCrud from "../memory/delivery-crud.js";
import * as deliveryStatus from "../memory/delivery-status.js";
import { getLogger } from "../util/logger.js";
import { deliverReplyViaCallback } from "./channel-reply-delivery.js";
import type { MessageProcessor } from "./http-types.js";
import { resolveRoutingStateFromRuntime } from "./trust-context-resolver.js";

const log = getLogger("runtime-http");

function parseTrustRuntimeContext(value: unknown): TrustContext | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const trustClass = raw.trustClass;
  if (
    trustClass !== "guardian" &&
    trustClass !== "trusted_contact" &&
    trustClass !== "unknown"
  ) {
    return undefined;
  }
  const rawSourceChannel =
    typeof raw.sourceChannel === "string" && raw.sourceChannel.trim().length > 0
      ? raw.sourceChannel
      : undefined;
  if (!rawSourceChannel || !isChannelId(rawSourceChannel)) return undefined;
  const sourceChannel = rawSourceChannel;
  return {
    sourceChannel,
    trustClass,
    guardianChatId:
      typeof raw.guardianChatId === "string" ? raw.guardianChatId : undefined,
    guardianExternalUserId:
      typeof raw.guardianExternalUserId === "string"
        ? raw.guardianExternalUserId
        : undefined,
    guardianPrincipalId:
      typeof raw.guardianPrincipalId === "string"
        ? raw.guardianPrincipalId
        : undefined,
    requesterIdentifier:
      typeof raw.requesterIdentifier === "string"
        ? raw.requesterIdentifier
        : undefined,
    requesterDisplayName:
      typeof raw.requesterDisplayName === "string"
        ? raw.requesterDisplayName
        : undefined,
    requesterSenderDisplayName:
      typeof raw.requesterSenderDisplayName === "string"
        ? raw.requesterSenderDisplayName
        : undefined,
    requesterMemberDisplayName:
      typeof raw.requesterMemberDisplayName === "string"
        ? raw.requesterMemberDisplayName
        : undefined,
    requesterExternalUserId:
      typeof raw.requesterExternalUserId === "string"
        ? raw.requesterExternalUserId
        : undefined,
    requesterChatId:
      typeof raw.requesterChatId === "string" ? raw.requesterChatId : undefined,
  };
}

/**
 * Periodically retry failed channel inbound events that have passed
 * their exponential backoff delay.
 */
export async function sweepFailedEvents(
  processMessage: MessageProcessor,
  mintBearerToken: (() => string) | undefined,
): Promise<void> {
  const events = deliveryStatus.getRetryableEvents();
  if (events.length === 0) return;

  log.info({ count: events.length }, "Retrying failed channel inbound events");

  for (const event of events) {
    if (!event.rawPayload) {
      // No payload stored -- can't replay, move to dead letter
      deliveryStatus.recordProcessingFailure(
        event.id,
        new Error("No raw payload stored for replay"),
      );
      continue;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(event.rawPayload) as Record<string, unknown>;
    } catch {
      deliveryStatus.recordProcessingFailure(
        event.id,
        new Error("Failed to parse stored raw payload"),
      );
      continue;
    }

    const content =
      typeof payload.content === "string" ? payload.content.trim() : "";
    const attachmentIds = Array.isArray(payload.attachmentIds)
      ? (payload.attachmentIds as string[])
      : undefined;
    const sourceChannel = parseChannelId(payload.sourceChannel);
    if (!sourceChannel) {
      deliveryStatus.recordProcessingFailure(
        event.id,
        new Error(`Invalid sourceChannel: ${String(payload.sourceChannel)}`),
      );
      continue;
    }
    const sourceInterface =
      parseInterfaceId(payload.interface) ??
      parseInterfaceId(payload.sourceChannel) ??
      "vellum";
    const sourceMetadata = payload.sourceMetadata as
      | Record<string, unknown>
      | undefined;
    const assistantId =
      typeof payload.assistantId === "string" ? payload.assistantId : undefined;
    const rawTrustCtx = payload.trustCtx;
    const parsedTrustContext = parseTrustRuntimeContext(rawTrustCtx);

    // If the stored payload had guardian context data but it couldn't be parsed
    // into a valid canonical shape (e.g., legacy actorRole-only payloads without
    // trustClass), fail the event deterministically rather than processing it
    // without guardian context. Without this check, the downstream default of
    // `trustClass ?? 'guardian'` would silently escalate privileges.
    if (rawTrustCtx && !parsedTrustContext) {
      log.warn(
        { eventId: event.id },
        "Stored trustCtx could not be parsed into canonical form; marking event as failed to prevent privilege escalation",
      );
      deliveryStatus.markRetryableFailure(
        event.id,
        "Unparseable guardian context in stored payload — refusing to process without trust classification",
      );
      continue;
    }

    // When trustCtx is entirely absent (pre-guardian events or events stored
    // before trust context was added), synthesize an explicit 'unknown' context.
    // This ensures replay never proceeds without an explicit trust classification
    // — downstream defaults like `trustClass ?? 'guardian'` would
    // otherwise grant guardian-level tool access to unclassified events.
    const trustContext: TrustContext = parsedTrustContext ?? {
      sourceChannel,
      trustClass: "unknown",
    };

    const metadataHintsRaw = sourceMetadata?.hints;
    const metadataHints = Array.isArray(metadataHintsRaw)
      ? metadataHintsRaw.filter(
          (h): h is string => typeof h === "string" && h.trim().length > 0,
        )
      : [];
    const metadataUxBrief =
      typeof sourceMetadata?.uxBrief === "string" &&
      sourceMetadata.uxBrief.trim().length > 0
        ? sourceMetadata.uxBrief.trim()
        : undefined;

    try {
      const { messageId: userMessageId } = await processMessage(
        event.conversationId,
        content,
        attachmentIds,
        {
          transport: {
            channelId: sourceChannel,
            hints: metadataHints.length > 0 ? metadataHints : undefined,
            uxBrief: metadataUxBrief,
          },
          assistantId,
          trustContext,
          isInteractive:
            resolveRoutingStateFromRuntime(trustContext).promptWaitingAllowed,
        },
        sourceChannel,
        sourceInterface,
      );
      deliveryCrud.linkMessage(event.id, userMessageId);
      deliveryStatus.markProcessed(event.id);
      log.info(
        { eventId: event.id },
        "Successfully replayed failed channel event",
      );

      const replyCallbackUrl =
        typeof payload.replyCallbackUrl === "string"
          ? payload.replyCallbackUrl
          : undefined;
      if (replyCallbackUrl) {
        const externalChatId =
          typeof payload.externalChatId === "string"
            ? payload.externalChatId
            : undefined;
        if (externalChatId) {
          // processMessage above generated a fresh assistant response, so any
          // previously tracked segment progress belongs to the old response and
          // must not carry over. Reset to 0 so we deliver all segments of the
          // new response.
          deliveryChannels.updateDeliveredSegmentCount(event.id, 0);
          await deliverReplyViaCallback(
            event.conversationId,
            externalChatId,
            replyCallbackUrl,
            mintBearerToken?.(),
            assistantId,
            {
              startFromSegment: 0,
              onSegmentDelivered: (count) =>
                deliveryChannels.updateDeliveredSegmentCount(event.id, count),
            },
          );
        }
      }
    } catch (err) {
      log.error({ err, eventId: event.id }, "Retry failed for channel event");
      deliveryStatus.recordProcessingFailure(event.id, err);
    }
  }
}
