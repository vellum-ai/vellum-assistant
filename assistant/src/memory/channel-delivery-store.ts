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
import { channelInboundEvents, conversations, messages } from './schema.js';
import { getOrCreateConversation } from './conversation-key-store.js';
import { getConfig } from '../config/loader.js';
import { indexMessageNow } from './indexer.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('channel-delivery-store');

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
  const messageId = uuid();

  // Wrap message insert + event insert in a single transaction so a partial
  // failure doesn't leave an orphaned message without an idempotency record.
  const message = { id: messageId, conversationId: mapping.conversationId, role: 'user', content, createdAt: now };

  db.transaction((tx) => {
    tx.insert(messages).values(message).run();
    tx.update(conversations)
      .set({ updatedAt: now })
      .where(eq(conversations.id, mapping.conversationId))
      .run();
    tx.insert(channelInboundEvents)
      .values({
        id: eventId,
        assistantId,
        sourceChannel,
        externalChatId,
        externalMessageId,
        conversationId: mapping.conversationId,
        messageId,
        deliveryStatus: 'pending',
        createdAt: now,
        updatedAt: now,
      })
      .run();
  });

  // Non-critical: index the message for memory retrieval after the transaction commits.
  try {
    const config = getConfig();
    indexMessageNow({
      messageId: message.id,
      conversationId: message.conversationId,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
    }, config.memory);
  } catch (err) {
    log.warn({ err, conversationId: mapping.conversationId, messageId }, 'Failed to index inbound message for memory');
  }

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
