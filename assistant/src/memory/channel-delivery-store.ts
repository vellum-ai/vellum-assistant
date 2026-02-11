/**
 * Channel inbound idempotency + delivery state tracking.
 *
 * Ensures duplicate channel messages (e.g. Telegram webhook retries)
 * don't produce duplicate replies. Tracks delivery acknowledgement
 * so the runtime owns the full lifecycle instead of web Postgres.
 */

import { eq, and } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { getDb } from './db.js';
import { channelInboundEvents } from './schema.js';
import { getOrCreateConversation } from './conversation-key-store.js';
import * as conversationStore from './conversation-store.js';

export interface InboundResult {
  accepted: boolean;
  eventId: string;
  conversationId: string;
  duplicate: boolean;
}

/**
 * Record an inbound channel event. Returns `duplicate: true` if this
 * exact (assistant, channel, chat, message) combination was already seen.
 */
export function recordInbound(
  assistantId: string,
  sourceChannel: string,
  externalChatId: string,
  externalMessageId: string,
  content: string,
): InboundResult {
  const db = getDb();

  const existing = db
    .select({
      id: channelInboundEvents.id,
      conversationId: channelInboundEvents.conversationId,
    })
    .from(channelInboundEvents)
    .where(
      and(
        eq(channelInboundEvents.assistantId, assistantId),
        eq(channelInboundEvents.sourceChannel, sourceChannel),
        eq(channelInboundEvents.externalChatId, externalChatId),
        eq(channelInboundEvents.externalMessageId, externalMessageId),
      ),
    )
    .get();

  if (existing) {
    return {
      accepted: true,
      eventId: existing.id,
      conversationId: existing.conversationId,
      duplicate: true,
    };
  }

  const conversationKey = `${sourceChannel}:${externalChatId}`;
  const mapping = getOrCreateConversation(assistantId, conversationKey);
  const now = Date.now();
  const eventId = uuid();

  // Store the inbound message in the conversation
  const msg = conversationStore.addMessage(mapping.conversationId, 'user', content);

  db.insert(channelInboundEvents)
    .values({
      id: eventId,
      assistantId,
      sourceChannel,
      externalChatId,
      externalMessageId,
      conversationId: mapping.conversationId,
      messageId: msg.id,
      deliveryStatus: 'pending',
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return {
    accepted: true,
    eventId,
    conversationId: mapping.conversationId,
    duplicate: false,
  };
}

/**
 * Acknowledge delivery of an outbound message for a channel event.
 */
export function acknowledgeDelivery(
  assistantId: string,
  sourceChannel: string,
  externalChatId: string,
  externalMessageId: string,
): boolean {
  const db = getDb();
  const now = Date.now();

  const existing = db
    .select({ id: channelInboundEvents.id })
    .from(channelInboundEvents)
    .where(
      and(
        eq(channelInboundEvents.assistantId, assistantId),
        eq(channelInboundEvents.sourceChannel, sourceChannel),
        eq(channelInboundEvents.externalChatId, externalChatId),
        eq(channelInboundEvents.externalMessageId, externalMessageId),
      ),
    )
    .get();

  if (!existing) return false;

  db.update(channelInboundEvents)
    .set({
      deliveryStatus: 'delivered',
      updatedAt: now,
    })
    .where(eq(channelInboundEvents.id, existing.id))
    .run();

  return true;
}
