/**
 * Channel delivery routes: delivery ack, dead letters, reply delivery,
 * and post-decision delivery scheduling.
 */
import * as channelDeliveryStore from '../../memory/channel-delivery-store.js';
import { httpError } from '../http-errors.js';
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
    return httpError('BAD_REQUEST', 'eventIds array is required', 400);
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
    return httpError('BAD_REQUEST', 'sourceChannel is required', 400);
  }
  if (!externalChatId || typeof externalChatId !== 'string') {
    return httpError('BAD_REQUEST', 'externalChatId is required', 400);
  }
  if (!externalMessageId || typeof externalMessageId !== 'string') {
    return httpError('BAD_REQUEST', 'externalMessageId is required', 400);
  }

  const acked = channelDeliveryStore.acknowledgeDelivery(
    sourceChannel,
    externalChatId,
    externalMessageId,
  );

  if (!acked) {
    return httpError('NOT_FOUND', 'Inbound event not found', 404);
  }

  return new Response(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// Reply delivery via callback
// ---------------------------------------------------------------------------
