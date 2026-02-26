/**
 * Channel delivery routes: delivery ack, dead letters, reply delivery,
 * and post-decision delivery scheduling.
 */
import * as channelDeliveryStore from '../../memory/channel-delivery-store.js';
export { type DeliverReplyOptions,deliverReplyViaCallback } from '../channel-reply-delivery.js';

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
