/**
 * Channel delivery routes: delivery ack, dead letters, reply delivery,
 * and post-decision delivery scheduling.
 */
import { renderHistoryContent } from '../../daemon/handlers.js';
import * as attachmentsStore from '../../memory/attachments-store.js';
import * as channelDeliveryStore from '../../memory/channel-delivery-store.js';
import * as conversationStore from '../../memory/conversation-store.js';
import { getLogger } from '../../util/logger.js';
import { deliverChannelReply } from '../gateway-client.js';
import type { RuntimeAttachmentMetadata } from '../http-types.js';

const log = getLogger('runtime-http');

// ---------------------------------------------------------------------------
// Dead letter management
// ---------------------------------------------------------------------------

export function handleListDeadLetters(): Response {
  const events = channelDeliveryStore.getDeadLetterEvents();
  return Response.json({ events });
}

export async function handleReplayDeadLetters(req: Request): Promise<Response> {
  const body = await req.json() as { eventIds?: string[] };
  const eventIds = body.eventIds;

  if (!Array.isArray(eventIds) || eventIds.length === 0) {
    return Response.json({ error: 'eventIds array is required' }, { status: 400 });
  }

  const replayed = channelDeliveryStore.replayDeadLetters(eventIds);
  return Response.json({ replayed });
}

// ---------------------------------------------------------------------------
// Delivery acknowledgement
// ---------------------------------------------------------------------------

export async function handleChannelDeliveryAck(req: Request): Promise<Response> {
  const body = await req.json() as {
    sourceChannel?: string;
    externalChatId?: string;
    externalMessageId?: string;
  };

  const { sourceChannel, externalChatId, externalMessageId } = body;

  if (!sourceChannel || typeof sourceChannel !== 'string') {
    return Response.json({ error: 'sourceChannel is required' }, { status: 400 });
  }
  if (!externalChatId || typeof externalChatId !== 'string') {
    return Response.json({ error: 'externalChatId is required' }, { status: 400 });
  }
  if (!externalMessageId || typeof externalMessageId !== 'string') {
    return Response.json({ error: 'externalMessageId is required' }, { status: 400 });
  }

  const acked = channelDeliveryStore.acknowledgeDelivery(
    sourceChannel,
    externalChatId,
    externalMessageId,
  );

  if (!acked) {
    return Response.json({ error: 'Inbound event not found' }, { status: 404 });
  }

  return new Response(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// Reply delivery via callback
// ---------------------------------------------------------------------------

export async function deliverReplyViaCallback(
  conversationId: string,
  externalChatId: string,
  callbackUrl: string,
  bearerToken?: string,
  assistantId?: string,
): Promise<void> {
  const msgs = conversationStore.getMessages(conversationId);
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant') {
      let parsed: unknown;
      try { parsed = JSON.parse(msgs[i].content); } catch { parsed = msgs[i].content; }
      const rendered = renderHistoryContent(parsed);

      const linked = attachmentsStore.getAttachmentMetadataForMessage(msgs[i].id);
      const replyAttachments: RuntimeAttachmentMetadata[] = linked.map((a) => ({
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

