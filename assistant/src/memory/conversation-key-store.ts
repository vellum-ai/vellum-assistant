/**
 * Maps conversation keys to internal conversation IDs.
 *
 * The web UI identifies conversations by an opaque `conversationKey` (e.g.
 * a user ID, a channel thread ID).  This store resolves those keys to the
 * daemon's internal conversation IDs, creating new conversations on
 * first contact.
 */

import { eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { getDb } from './db.js';
import { conversations, conversationKeys } from './schema.js';

export interface ConversationKeyMapping {
  id: string;
  conversationKey: string;
  conversationId: string;
  createdAt: number;
}

/**
 * Look up the conversation ID for a given conversationKey.
 * Returns `null` if no mapping exists yet.
 */
export function getConversationByKey(
  conversationKey: string,
): ConversationKeyMapping | null {
  const db = getDb();
  const result = db
    .select()
    .from(conversationKeys)
    .where(eq(conversationKeys.conversationKey, conversationKey))
    .get();
  return result ?? null;
}

/**
 * Delete the conversation-key mapping for a given conversationKey.
 *
 * This is a soft reset: the old conversation data remains in the database,
 * but it is no longer reachable via this key.  The next message with the
 * same key will create a fresh conversation.
 *
 */
export function deleteConversationKey(
  conversationKey: string,
): void {
  const db = getDb();
  db.delete(conversationKeys)
    .where(eq(conversationKeys.conversationKey, conversationKey))
    .run();
}

/**
 * Get or create a conversation for the given conversationKey.
 *
 * If a mapping already exists, returns the existing conversation ID.
 * Otherwise, creates a new conversation and mapping atomically within a
 * single transaction to prevent race conditions and orphaned rows.
 */
export function getOrCreateConversation(
  conversationKey: string,
): { conversationId: string; created: boolean } {
  const db = getDb();

  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(conversationKeys)
      .where(eq(conversationKeys.conversationKey, conversationKey))
      .get();

    if (existing) {
      return { conversationId: existing.conversationId, created: false };
    }

    const now = Date.now();
    const conversationId = uuid();

    tx.insert(conversations)
      .values({
        id: conversationId,
        title: `Runtime: ${conversationKey}`,
        createdAt: now,
        updatedAt: now,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalEstimatedCost: 0,
        contextSummary: null,
        contextCompactedMessageCount: 0,
        contextCompactedAt: null,
      })
      .run();

    tx.insert(conversationKeys)
      .values({
        id: uuid(),
        assistantId: 'self',
        conversationKey,
        conversationId,
        createdAt: now,
      })
      .run();

    return { conversationId, created: true };
  });
}
