/**
 * Periodic retry sweep for failed channel inbound events.
 */

import {
  isChannelId,
  parseChannelId,
  parseInterfaceId,
} from "../channels/types.js";
import { getDiskPressureStatus } from "../daemon/disk-pressure-guard.js";
import { classifyDiskPressureTurnPolicy } from "../daemon/disk-pressure-policy.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import type { TrustContext } from "../daemon/trust-context.js";
import {
  addSlackDmLiveDeliveredTextResponseIndex,
  getSlackDmLiveDeliveredTextResponseIndexes,
  updateDeliveredSegmentCount,
} from "../memory/delivery-channels.js";
import {
  clearPayload,
  linkMessage,
  storeReplyMessageId,
} from "../memory/delivery-crud.js";
import {
  getRetryableDeliveryEvents,
  getRetryableEvents,
  markDeliveryDelivered,
  markProcessed,
  markRetryableFailure,
  recordDeliveryFailure,
  recordProcessingFailure,
} from "../memory/delivery-status.js";
import { getLogger } from "../util/logger.js";
import {
  deliverReplyViaCallback,
  findAssistantReplyMessageIdForTurn,
} from "./channel-reply-delivery.js";
import { deliverChannelReply } from "./gateway-client.js";
import type { MessageProcessor } from "./http-types.js";
import { createSlackDmTextDeliveryController } from "./slack-dm-text-delivery.js";
import { resolveRoutingStateFromRuntime } from "./trust-context-resolver.js";

const log = getLogger("runtime-http");
const DISK_PRESSURE_REMOTE_BLOCK_REPLY =
  "Storage is critically low, so remote messages are ignored until the guardian frees enough space. Please try again later.";

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
): Promise<void> {
  const events = getRetryableEvents();
  const deliveryEvents = getRetryableDeliveryEvents();
  if (events.length === 0 && deliveryEvents.length === 0) return;

  log.info(
    { processingCount: events.length, deliveryCount: deliveryEvents.length },
    "Retrying failed channel inbound events",
  );

  for (const event of events) {
    if (!event.rawPayload) {
      // No payload stored -- can't replay, move to dead letter
      recordProcessingFailure(
        event.id,
        new Error("No raw payload stored for replay"),
      );
      continue;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(event.rawPayload) as Record<string, unknown>;
    } catch {
      recordProcessingFailure(
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
      recordProcessingFailure(
        event.id,
        new Error(`Invalid sourceChannel: ${String(payload.sourceChannel)}`),
      );
      continue;
    }
    const sourceInterface =
      parseInterfaceId(payload.interface) ??
      parseInterfaceId(payload.sourceChannel) ??
      "web";
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
      markRetryableFailure(
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

    const diskPressureDecision = classifyDiskPressureTurnPolicy(
      getDiskPressureStatus(),
      {
        sourceChannel,
        sourceInterface,
        trustContext: {
          sourceChannel: trustContext.sourceChannel,
          trustClass: trustContext.trustClass,
        },
      },
    );
    if (diskPressureDecision.action === "block") {
      clearPayload(event.id);
      markProcessed(event.id);
      log.info(
        {
          eventId: event.id,
          conversationId: event.conversationId,
          reason: diskPressureDecision.reason,
          trustClass: trustContext.trustClass,
        },
        "Skipped channel retry during disk pressure cleanup mode",
      );

      const replyCallbackUrl =
        typeof payload.replyCallbackUrl === "string"
          ? payload.replyCallbackUrl
          : undefined;
      const externalChatId =
        typeof payload.externalChatId === "string"
          ? payload.externalChatId
          : undefined;
      if (replyCallbackUrl && externalChatId) {
        const requesterExternalUserId =
          trustContext.requesterExternalUserId ??
          (typeof payload.senderExternalUserId === "string"
            ? payload.senderExternalUserId
            : undefined);
        const replyPayload: Parameters<typeof deliverChannelReply>[1] = {
          chatId: externalChatId,
          text: DISK_PRESSURE_REMOTE_BLOCK_REPLY,
          assistantId,
        };
        if (sourceChannel === "slack" && requesterExternalUserId) {
          replyPayload.ephemeral = true;
          replyPayload.user = requesterExternalUserId;
        }
        try {
          await deliverChannelReply(replyCallbackUrl, replyPayload);
        } catch (err) {
          log.warn(
            { err, eventId: event.id, conversationId: event.conversationId },
            "Failed to deliver disk pressure retry block reply",
          );
        }
      }
      continue;
    }

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
    const metadataChatType =
      typeof sourceMetadata?.chatType === "string" &&
      sourceMetadata.chatType.trim().length > 0
        ? sourceMetadata.chatType.trim()
        : undefined;
    const replyCallbackUrl =
      typeof payload.replyCallbackUrl === "string"
        ? payload.replyCallbackUrl
        : undefined;
    const externalChatId =
      typeof payload.externalChatId === "string"
        ? payload.externalChatId
        : undefined;
    const slackDmTextDelivery = externalChatId
      ? createSlackDmTextDeliveryController({
          sourceChannel,
          chatType: metadataChatType,
          replyCallbackUrl,
          chatId: externalChatId,
          assistantId,
          deliveredTextResponseIndexes:
            getSlackDmLiveDeliveredTextResponseIndexes(event.id),
          onTextResponseDelivered: (responseIndex) =>
            addSlackDmLiveDeliveredTextResponseIndex(event.id, responseIndex),
        })
      : undefined;
    let replyMessageId: string | undefined;
    const observeAgentEvent = (msg: ServerMessage): void => {
      if (
        msg.type === "message_complete" &&
        (msg.source === undefined || msg.source === "main") &&
        typeof msg.messageId === "string"
      ) {
        replyMessageId = msg.messageId;
      }
      slackDmTextDelivery?.observeEvent(msg);
    };

    let userMessageId: string | undefined;
    try {
      const result = await processMessage(event.conversationId, content, {
        attachmentIds,
        transport: {
          channelId: sourceChannel,
          hints: metadataHints.length > 0 ? metadataHints : undefined,
          uxBrief: metadataUxBrief,
          chatType: metadataChatType,
        },
        assistantId,
        trustContext,
        isInteractive:
          resolveRoutingStateFromRuntime(trustContext).promptWaitingAllowed,
        onEvent: observeAgentEvent,
        sourceChannel,
        sourceInterface,
      });
      userMessageId = result.messageId;
      linkMessage(event.id, userMessageId);
      markProcessed(event.id);
      replyMessageId ??= result.assistantMessageId;
      if (replyMessageId) {
        storeReplyMessageId(event.id, replyMessageId);
      }
      log.info(
        { eventId: event.id },
        "Successfully replayed failed channel event",
      );
    } catch (err) {
      log.error({ err, eventId: event.id }, "Retry failed for channel event");
      if (slackDmTextDelivery) {
        await slackDmTextDelivery.waitForPendingDeliveries();
      }
      recordProcessingFailure(event.id, err);
      continue;
    }

    if (replyCallbackUrl) {
      if (externalChatId) {
        try {
          if (slackDmTextDelivery) {
            await slackDmTextDelivery.waitForPendingDeliveries();
          }
          // processMessage above generated a fresh assistant response, so any
          // previously tracked final-delivery progress belongs to the old
          // response and must not carry over. Use live Slack DM progress as
          // the new baseline before final delivery so delivery-only retries do
          // not duplicate text if the callback fails before reporting progress.
          const liveDeliveryResumeOptions =
            slackDmTextDelivery?.getFinalDeliveryResumeOptions(replyMessageId);
          const finalDeliveryStartFromSegment =
            liveDeliveryResumeOptions?.startFromSegment ?? 0;
          updateDeliveredSegmentCount(event.id, finalDeliveryStartFromSegment);
          await deliverReplyViaCallback(
            event.conversationId,
            externalChatId,
            replyCallbackUrl,
            assistantId,
            {
              messageId: replyMessageId,
              sinceMessageId: userMessageId,
              startFromSegment: finalDeliveryStartFromSegment,
              ...(liveDeliveryResumeOptions?.messageTs
                ? { messageTs: liveDeliveryResumeOptions.messageTs }
                : {}),
              onSegmentDelivered: (count) =>
                updateDeliveredSegmentCount(event.id, count),
            },
          );
          markDeliveryDelivered(event.id);
        } catch (err) {
          log.error(
            { err, eventId: event.id },
            "Retry delivery failed for channel event",
          );
          recordDeliveryFailure(event.id, err);
        }
      }
    }
  }

  for (const event of deliveryEvents) {
    if (!event.rawPayload) {
      recordDeliveryFailure(
        event.id,
        new Error("No raw payload stored for delivery retry"),
      );
      continue;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(event.rawPayload) as Record<string, unknown>;
    } catch {
      recordDeliveryFailure(
        event.id,
        new Error("Failed to parse stored raw payload for delivery retry"),
      );
      continue;
    }

    const replyCallbackUrl =
      typeof payload.replyCallbackUrl === "string"
        ? payload.replyCallbackUrl
        : undefined;
    const externalChatId =
      typeof payload.externalChatId === "string"
        ? payload.externalChatId
        : undefined;
    let replyMessageId =
      typeof payload.replyMessageId === "string"
        ? payload.replyMessageId
        : undefined;
    const assistantId =
      typeof payload.assistantId === "string" ? payload.assistantId : undefined;
    if (!replyCallbackUrl || !externalChatId) {
      recordDeliveryFailure(
        event.id,
        new Error("Stored payload is missing delivery callback details"),
      );
      continue;
    }
    if (!replyMessageId && event.messageId) {
      replyMessageId = findAssistantReplyMessageIdForTurn(
        event.conversationId,
        event.messageId,
      );
      if (replyMessageId) {
        storeReplyMessageId(event.id, replyMessageId);
      }
    }
    if (!replyMessageId) {
      recordDeliveryFailure(
        event.id,
        new Error("Stored payload is missing assistant reply message id"),
      );
      continue;
    }

    try {
      await deliverReplyViaCallback(
        event.conversationId,
        externalChatId,
        replyCallbackUrl,
        assistantId,
        {
          messageId: replyMessageId,
          startFromSegment: event.deliveredSegmentCount,
          onSegmentDelivered: (count) =>
            updateDeliveredSegmentCount(event.id, count),
        },
      );
      markDeliveryDelivered(event.id);
    } catch (err) {
      log.error(
        { err, eventId: event.id },
        "Retry delivery failed for processed channel event",
      );
      recordDeliveryFailure(event.id, err);
    }
  }
}
