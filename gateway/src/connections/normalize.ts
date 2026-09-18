import { z } from "zod";

import type { ConnectionsInboundEvent } from "../channels/inbound-event.js";

// A connections delivery is one message a Vellum user wrote to this assistant
// from their own Vellum. The platform authenticated the sender by their Vellum
// session and signed the body with this assistant's webhook secret; the route
// verifies that signature before anything here runs. The body is still parsed
// as untrusted input: the fields the event is keyed on are required, and a
// malformed display field collapses to `undefined` rather than dropping the
// message.

const optionalString = () => z.string().optional().catch(undefined);

const deliverySchema = z.object({
  /** One delivery occurrence: the dedup key and the external message id. */
  eventId: z.string().min(1),
  /** Unix seconds the platform signed the delivery at; bounds replay. */
  issuedAt: z.number().int(),
  /** The platform thread the message belongs to; one conversation per thread. */
  threadId: z.string().min(1),
  sender: z.object({
    /** The sender's platform user id, their identity on this channel. */
    userId: z.string().min(1),
    displayName: optionalString(),
    username: optionalString(),
  }),
  text: z.string().min(1),
});

const payloadSchema = z.record(z.string(), z.unknown());

export type NormalizedConnectionsDelivery = {
  event: ConnectionsInboundEvent;
  eventId: string;
  issuedAt: number;
};

/**
 * Turn a verified connections delivery into the canonical inbound event, or
 * `null` when a field the event is keyed on is missing or malformed.
 *
 * Only the sender reads a thread, so every event is a direct message: the
 * readership fact verification codes key on, and the permission matrix's `dm`
 * visibility tier.
 */
export function normalizeConnectionsDelivery(
  payload: unknown,
): NormalizedConnectionsDelivery | null {
  const record = payloadSchema.safeParse(payload);
  if (!record.success) {
    return null;
  }
  const parsed = deliverySchema.safeParse(record.data);
  if (!parsed.success) {
    return null;
  }
  const { eventId, issuedAt, threadId, sender, text } = parsed.data;

  return {
    eventId,
    issuedAt,
    event: {
      version: "v1",
      sourceChannel: "connections",
      receivedAt: new Date().toISOString(),
      message: {
        content: text,
        conversationExternalId: threadId,
        externalMessageId: eventId,
        eventKind: "message",
      },
      actor: {
        actorExternalId: sender.userId,
        ...(sender.displayName ? { displayName: sender.displayName } : {}),
        ...(sender.username ? { username: sender.username } : {}),
      },
      source: {
        updateId: eventId,
        messageId: eventId,
        chatType: "dm",
        conversationType: "dm",
        isDirectMessage: true,
      },
      raw: record.data,
    },
  };
}
