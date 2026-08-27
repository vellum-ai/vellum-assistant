/**
 * Builds the Discord Gateway callback that ingests and forwards messages.
 */
import type { Logger } from "pino";

import type { GatewayConfig } from "../config.js";
import {
  appendFailedAttachmentNotice,
  ingestAttachments,
} from "../attachments/ingest.js";
import type { ConversationTaskQueue } from "../channels/conversation-queue.js";
import type { DiscordGatewayEventHandler } from "./gateway-socket.js";
import { downloadDiscordFile } from "./download.js";
import { uploadAttachment } from "../runtime/client.js";
import { handleInbound } from "../handlers/handle-inbound.js";
import { upsertContactChannel } from "../verification/contact-helpers.js";

export function createDiscordInboundEventHandler(options: {
  config: GatewayConfig;
  log: Logger;
  notifyRecordActivity: () => void;
  forwardQueue: ConversationTaskQueue;
}): DiscordGatewayEventHandler {
  const { config, log, notifyRecordActivity, forwardQueue } = options;

  return (event, attachmentRefs) => {
    // Reset the platform idle-sleep timer so inbound Discord activity keeps
    // the assistant awake like any other channel.
    notifyRecordActivity();

    // A guild channel is a room the actor is standing in, not their private
    // delivery address. Recording it as externalChatId would post private
    // notices in public, so only DMs carry that field. An unattributed
    // event's actor is a synthetic system id, not a person: seeding a
    // contact from it would mint a ghost and, on a DM, bind that ghost to a
    // real conversation.
    if (!event.source.actorUnattributed) {
      void upsertContactChannel({
        sourceChannel: "discord",
        externalUserId: event.actor.actorExternalId,
        ...(event.source.chatType === "dm"
          ? { externalChatId: event.message.conversationExternalId }
          : {}),
        displayName: event.actor.displayName,
        username: event.actor.username,
      }).catch(() => {});
    }

    // The event's conversation address is the parent channel for threaded
    // messages, and a Discord thread is itself a channel. Include the thread
    // snowflake so replies stay inside the thread.
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
              download: (attachment, maxBytes) => {
                const reference = attachmentRefs.get(attachment.fileId);
                if (!reference) {
                  throw new Error(
                    `No Discord attachment found for ${attachment.fileId}`,
                  );
                }
                return downloadDiscordFile(reference, maxBytes, log);
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
