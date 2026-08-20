/**
 * Builds the Discord Gateway callback that ingests and forwards messages.
 */
import type { Logger } from "pino";

import type { GatewayConfig } from "../config.js";
import type { DiscordInboundEvent } from "../channels/inbound-event.js";
import {
  appendFailedAttachmentNotice,
  ingestAttachments,
} from "../attachments/ingest.js";
import type { DownloadedAttachment } from "../attachments/ingest.js";
import type { ConversationTaskQueue } from "../channels/conversation-queue.js";
import type { DiscordGatewayEventHandler } from "./gateway-socket.js";
import type { DiscordAttachmentReference } from "./attachments.js";
import type {
  HandleInboundOptions,
  InboundResult,
} from "../handlers/handle-inbound.js";
import type { UpsertContactChannelParams } from "../verification/contact-helpers.js";

export function createDiscordInboundEventHandler(options: {
  config: GatewayConfig;
  log: Logger;
  notifyRecordActivity: () => void;
  forwardQueue: ConversationTaskQueue;
  downloadDiscordFile: (
    attachment: DiscordAttachmentReference,
  ) => Promise<DownloadedAttachment>;
  uploadAttachment: (
    config: GatewayConfig,
    input: DownloadedAttachment,
    options?: { skipCircuitBreaker?: boolean },
  ) => Promise<{ id: string }>;
  handleInbound: (
    config: GatewayConfig,
    event: DiscordInboundEvent,
    options?: HandleInboundOptions,
  ) => Promise<InboundResult>;
  upsertContactChannel: (params: UpsertContactChannelParams) => Promise<void>;
}): DiscordGatewayEventHandler {
  const {
    config,
    log,
    notifyRecordActivity,
    forwardQueue,
    downloadDiscordFile,
    uploadAttachment,
    handleInbound,
    upsertContactChannel,
  } = options;

  return (event, attachmentRefs) => {
    notifyRecordActivity();

    void upsertContactChannel({
      sourceChannel: "discord",
      externalUserId: event.actor.actorExternalId,
      ...(event.source.chatType === "dm"
        ? { externalChatId: event.message.conversationExternalId }
        : {}),
      displayName: event.actor.displayName,
      username: event.actor.username,
    }).catch(() => {});

    const threadId = event.source.threadId;
    const replyCallbackUrl = threadId
      ? `${config.gatewayInternalBaseUrl}/deliver/discord?${new URLSearchParams({ threadId })}`
      : `${config.gatewayInternalBaseUrl}/deliver/discord`;

    const forward = async () => {
      try {
        let attachmentIds: string[] | undefined;
        const eventAttachments = event.message.attachments;
        if (eventAttachments && eventAttachments.length > 0 && attachmentRefs) {
          const result = await ingestAttachments(
            config,
            "discord",
            eventAttachments,
            log,
            {
              download: (attachment) => {
                const reference = attachmentRefs.get(attachment.fileId);
                if (!reference) {
                  throw new Error(
                    `No Discord attachment found for ${attachment.fileId}`,
                  );
                }
                return downloadDiscordFile(reference);
              },
              upload: (downloaded) =>
                uploadAttachment(config, downloaded, {
                  skipCircuitBreaker: true,
                }),
              failurePolicy: { mode: "skip" },
            },
          );
          attachmentIds = result.attachmentIds;
          event.message.content = appendFailedAttachmentNotice(
            event.message.content,
            result.failedAttachmentNames,
          );
        }

        await handleInbound(config, event, {
          replyCallbackUrl,
          ...(attachmentIds && attachmentIds.length > 0
            ? { attachmentIds }
            : {}),
        }).catch((err) => {
          log.error(
            {
              err,
              conversationExternalId: event.message.conversationExternalId,
            },
            "Failed to forward Discord event to runtime",
          );
        });
      } catch (err) {
        log.error(
          {
            err,
            conversationExternalId: event.message.conversationExternalId,
          },
          "Failed to process Discord event, delivering without attachments",
        );
        await handleInbound(config, event, { replyCallbackUrl }).catch(
          (fwdErr) => {
            log.error(
              {
                err: fwdErr,
                conversationExternalId: event.message.conversationExternalId,
              },
              "Failed to forward Discord event to runtime (fallback)",
            );
          },
        );
      }
    };

    void forwardQueue
      .enqueue(event.message.conversationExternalId, forward)
      .catch((err) => {
        log.error(
          {
            err,
            conversationExternalId: event.message.conversationExternalId,
          },
          "Unhandled error in Discord forward",
        );
      });
  };
}
