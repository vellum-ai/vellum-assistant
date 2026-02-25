/**
 * Periodic retry sweep for failed channel inbound events.
 */

import { parseChannelId, isChannelId } from '../channels/types.js';
import { getLogger } from '../util/logger.js';
import * as channelDeliveryStore from '../memory/channel-delivery-store.js';
import * as conversationStore from '../memory/conversation-store.js';
import * as attachmentsStore from '../memory/attachments-store.js';
import { renderHistoryContent } from '../daemon/handlers.js';
import { deliverChannelReply } from './gateway-client.js';
import type { GuardianRuntimeContext } from '../daemon/session-runtime-assembly.js';
import type { MessageProcessor } from './http-types.js';

const log = getLogger('runtime-http');

function parseGuardianRuntimeContext(value: unknown): GuardianRuntimeContext | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const actorRole = raw.actorRole;
  if (
    actorRole !== 'guardian'
    && actorRole !== 'non-guardian'
    && actorRole !== 'unverified_channel'
  ) {
    return undefined;
  }
  const rawSourceChannel = typeof raw.sourceChannel === 'string' && raw.sourceChannel.trim().length > 0
    ? raw.sourceChannel
    : undefined;
  if (!rawSourceChannel || !isChannelId(rawSourceChannel)) return undefined;
  const sourceChannel = rawSourceChannel;
  const denialReason =
    raw.denialReason === 'no_binding' || raw.denialReason === 'no_identity'
      ? raw.denialReason
      : undefined;
  return {
    sourceChannel,
    actorRole,
    guardianChatId: typeof raw.guardianChatId === 'string' ? raw.guardianChatId : undefined,
    guardianExternalUserId: typeof raw.guardianExternalUserId === 'string' ? raw.guardianExternalUserId : undefined,
    requesterIdentifier: typeof raw.requesterIdentifier === 'string' ? raw.requesterIdentifier : undefined,
    requesterExternalUserId: typeof raw.requesterExternalUserId === 'string' ? raw.requesterExternalUserId : undefined,
    requesterChatId: typeof raw.requesterChatId === 'string' ? raw.requesterChatId : undefined,
    denialReason,
  };
}

/**
 * Periodically retry failed channel inbound events that have passed
 * their exponential backoff delay.
 */
export async function sweepFailedEvents(
  processMessage: MessageProcessor,
  bearerToken: string | undefined,
): Promise<void> {
  const events = channelDeliveryStore.getRetryableEvents();
  if (events.length === 0) return;

  log.info({ count: events.length }, 'Retrying failed channel inbound events');

  for (const event of events) {
    if (!event.rawPayload) {
      // No payload stored -- can't replay, move to dead letter
      channelDeliveryStore.recordProcessingFailure(
        event.id,
        new Error('No raw payload stored for replay'),
      );
      continue;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(event.rawPayload) as Record<string, unknown>;
    } catch {
      channelDeliveryStore.recordProcessingFailure(
        event.id,
        new Error('Failed to parse stored raw payload'),
      );
      continue;
    }

    const content = typeof payload.content === 'string' ? payload.content.trim() : '';
    const attachmentIds = Array.isArray(payload.attachmentIds) ? payload.attachmentIds as string[] : undefined;
    const sourceChannel = parseChannelId(payload.sourceChannel);
    if (!sourceChannel) {
      channelDeliveryStore.recordProcessingFailure(
        event.id,
        new Error(`Invalid sourceChannel: ${String(payload.sourceChannel)}`),
      );
      continue;
    }
    const sourceMetadata = payload.sourceMetadata as Record<string, unknown> | undefined;
    const assistantId = typeof payload.assistantId === 'string'
      ? payload.assistantId
      : undefined;
    const guardianContext = parseGuardianRuntimeContext(payload.guardianCtx);

    const metadataHintsRaw = sourceMetadata?.hints;
    const metadataHints = Array.isArray(metadataHintsRaw)
      ? metadataHintsRaw.filter((h): h is string => typeof h === 'string' && h.trim().length > 0)
      : [];
    const metadataUxBrief = typeof sourceMetadata?.uxBrief === 'string' && sourceMetadata.uxBrief.trim().length > 0
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
          guardianContext,
        },
        sourceChannel,
        sourceChannel, // Retry sweep: interface matches channel
      );
      channelDeliveryStore.linkMessage(event.id, userMessageId);
      channelDeliveryStore.markProcessed(event.id);
      log.info({ eventId: event.id }, 'Successfully replayed failed channel event');

      const replyCallbackUrl = typeof payload.replyCallbackUrl === 'string'
        ? payload.replyCallbackUrl
        : undefined;
      if (replyCallbackUrl) {
        const externalChatId = typeof payload.externalChatId === 'string'
          ? payload.externalChatId
          : undefined;
        if (externalChatId) {
          await deliverReplyViaCallback(
            event.conversationId,
            externalChatId,
            replyCallbackUrl,
            bearerToken,
            assistantId,
          );
        }
      }
    } catch (err) {
      log.error({ err, eventId: event.id }, 'Retry failed for channel event');
      channelDeliveryStore.recordProcessingFailure(event.id, err);
    }
  }
}

async function deliverReplyViaCallback(
  conversationId: string,
  externalChatId: string,
  callbackUrl: string,
  bearerToken: string | undefined,
  assistantId?: string,
): Promise<void> {
  const msgs = conversationStore.getMessages(conversationId);
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant') {
      let parsed: unknown;
      try { parsed = JSON.parse(msgs[i].content); } catch { parsed = msgs[i].content; }
      const rendered = renderHistoryContent(parsed);

      const linked = attachmentsStore.getAttachmentMetadataForMessage(msgs[i].id);
      const replyAttachments = linked.map((a) => ({
        id: a.id,
        filename: a.originalFilename,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        kind: a.kind,
      }));

      if (rendered.text || replyAttachments.length > 0) {
        await deliverChannelReply(callbackUrl, {
          chatId: externalChatId,
          text: rendered.text || undefined,
          attachments: replyAttachments.length > 0 ? replyAttachments : undefined,
          assistantId,
        }, bearerToken);
      }
      break;
    }
  }
}
