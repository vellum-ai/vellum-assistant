/**
 * Channel delivery routes: delivery ack, dead letters, reply delivery,
 * and post-decision delivery scheduling.
 */
import { acknowledgeDelivery, getDeadLetterEvents, replayDeadLetters } from "../../memory/delivery-status.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import type { RouteHandlerArgs } from "./types.js";

export {
  type DeliverReplyOptions,
  deliverReplyViaCallback,
} from "../channel-reply-delivery.js";

// ---------------------------------------------------------------------------
// Dead letter management
// ---------------------------------------------------------------------------

export function handleListDeadLetters() {
  const events = getDeadLetterEvents();
  return { events };
}

export function handleReplayDeadLetters({ body = {} }: RouteHandlerArgs) {
  const { eventIds } = body as { eventIds?: string[] };

  if (!Array.isArray(eventIds) || eventIds.length === 0) {
    throw new BadRequestError("eventIds array is required");
  }

  const replayed = replayDeadLetters(eventIds);
  return { replayed };
}

// ---------------------------------------------------------------------------
// Delivery acknowledgement
// ---------------------------------------------------------------------------

export function handleChannelDeliveryAck({ body = {} }: RouteHandlerArgs) {
  const { sourceChannel, conversationExternalId, externalMessageId } =
    body as {
      sourceChannel?: string;
      conversationExternalId?: string;
      externalMessageId?: string;
    };

  if (!sourceChannel || typeof sourceChannel !== "string") {
    throw new BadRequestError("sourceChannel is required");
  }
  if (!conversationExternalId || typeof conversationExternalId !== "string") {
    throw new BadRequestError("conversationExternalId is required");
  }
  if (!externalMessageId || typeof externalMessageId !== "string") {
    throw new BadRequestError("externalMessageId is required");
  }

  const acked = acknowledgeDelivery(
    sourceChannel,
    conversationExternalId,
    externalMessageId,
  );

  if (!acked) {
    throw new NotFoundError("Inbound event not found");
  }

  return null;
}

// ---------------------------------------------------------------------------
// Reply delivery via callback
// ---------------------------------------------------------------------------
