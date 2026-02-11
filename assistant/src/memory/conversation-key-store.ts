/**
 * Maps (assistant_id, conversation_key) pairs to internal conversation IDs.
 *
 * The web UI identifies conversations by an opaque `conversationKey` (e.g.
 * a user ID, a channel thread ID).  This store resolves those keys to the
 * assistant's internal conversation IDs, creating new conversations on
 * first contact.
 */

import { eq, and } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { getDb } from './db.js';
import { conversationKeys } from './schema.js';
import { createConversation } from './conversation-store.js';

export interface ConversationKeyMapping {
  id: string;
  assistantId: string;
  conversationKey: string;
  conversationId: string;
  createdAt: number;
}

/**
 * Look up the conversation ID for a given (assistantId, conversationKey).
 * Returns `null` if no mapping exists yet.
 */
export function getConversationByKey(
  assistantId: string,
  conversationKey: string,
): ConversationKeyMapping | null {
  const db = getDb();
  const result = db
    .select()
    .from(conversationKeys)
    .where(
      and(
        eq(conversationKeys.assistantId, assistantId),
        eq(conversationKeys.conversationKey, conversationKey),
      ),
    )
    .get();
  return result ?? null;
}

/**
 * Get or create a conversation for the given (assistantId, conversationKey).
 *
 * If a mapping already exists, returns the existing conversation ID.
 * Otherwise, creates a new conversation and mapping atomically.
 */
export function getOrCreateConversation(
  assistantId: string,
  conversationKey: string,
): { conversationId: string; created: boolean } {
  const existing = getConversationByKey(assistantId, conversationKey);
  if (existing) {
    return { conversationId: existing.conversationId, created: false };
  }

  const conversation = createConversation(`Runtime: ${conversationKey}`);
  const db = getDb();
  const now = Date.now();

  db.insert(conversationKeys)
    .values({
      id: uuid(),
      assistantId,
      conversationKey,
      conversationId: conversation.id,
      createdAt: now,
    })
    .run();

  return { conversationId: conversation.id, created: true };
}
