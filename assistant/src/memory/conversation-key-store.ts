/**
 * Maps conversation keys to internal conversation IDs.
 *
 * The web UI identifies conversations by an opaque `conversationKey` (e.g.
 * a user ID, a channel chat ID).  This store resolves those keys to the
 * daemon's internal conversation IDs, creating new conversations on
 * first contact.
 */

import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { isChannelId } from "../channels/types.js";
import { initConversationDir } from "./conversation-disk-view.js";
import { GENERATING_TITLE } from "./conversation-title-service.js";
import { getDb } from "./db.js";
import { conversationKeys, conversations } from "./schema.js";

/**
 * Derive a memoryScopeId from a scoped conversation key.
 * Keys from channel inbound have the shape `asst:<assistantId>:<channel>:<chatId>`.
 * When the channel segment is a recognised ChannelId (slack, telegram, etc.)
 * we scope memories to that channel type so desktop memories don't leak into
 * Slack and vice-versa. Desktop / unknown keys fall back to "default".
 */
function deriveChannelScope(conversationKey: string): string {
  const parts = conversationKey.split(":");
  // asst:<assistantId>:<channel>:<chatId>
  if (parts.length >= 4 && parts[0] === "asst") {
    const channel = parts[2];
    if (isChannelId(channel) && channel !== "vellum") {
      return `channel:${channel}`;
    }
  }
  return "default";
}

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
export function deleteConversationKey(conversationKey: string): void {
  const db = getDb();
  db.delete(conversationKeys)
    .where(eq(conversationKeys.conversationKey, conversationKey))
    .run();
}

/**
 * Map a conversation key to an existing conversation ID (no creation).
 */
export function setConversationKey(
  conversationKey: string,
  conversationId: string,
): void {
  const db = getDb();
  db.insert(conversationKeys)
    .values({
      id: uuid(),
      conversationKey,
      conversationId,
      createdAt: Date.now(),
    })
    .run();
}

/**
 * Insert a conversation-key mapping only if the key does not already exist.
 *
 * Uses `onConflictDoNothing` on the unique `conversationKey` column to
 * avoid unique-constraint races when concurrent first messages attempt
 * to migrate a legacy key to a new scoped alias.
 */
export function setConversationKeyIfAbsent(
  conversationKey: string,
  conversationId: string,
): void {
  const db = getDb();
  db.insert(conversationKeys)
    .values({
      id: uuid(),
      conversationKey,
      conversationId,
      createdAt: Date.now(),
    })
    .onConflictDoNothing()
    .run();
}

/**
 * Resolve a value that may be either a conversation ID or a conversation key
 * to the daemon's internal conversation ID.
 *
 * Returns the internal conversation ID, or `null` if neither lookup succeeds.
 * Useful for endpoints (regenerate, undo, seen) that receive IDs from clients
 * which may be conversation keys rather than internal IDs.
 */
export function resolveConversationId(idOrKey: string): string | null {
  const db = getDb();

  // Fast path: check if it's already a valid conversation ID.
  const direct = db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.id, idOrKey))
    .get();
  if (direct) return direct.id;

  // Slow path: check if it's a conversation key.
  const mapping = db
    .select()
    .from(conversationKeys)
    .where(eq(conversationKeys.conversationKey, idOrKey))
    .get();
  return mapping?.conversationId ?? null;
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
  opts?: { conversationType?: "standard" | "private" },
): {
  conversationId: string;
  conversationType: string;
  created: boolean;
} {
  const db = getDb();
  const conversationType = opts?.conversationType ?? "standard";

  const result = db.transaction((tx) => {
    const existing = tx
      .select()
      .from(conversationKeys)
      .where(eq(conversationKeys.conversationKey, conversationKey))
      .get();

    if (existing) {
      const conv = tx
        .select({ conversationType: conversations.conversationType })
        .from(conversations)
        .where(eq(conversations.id, existing.conversationId))
        .get();
      return {
        conversationId: existing.conversationId,
        conversationType: conv?.conversationType ?? "standard",
        created: false as const,
      };
    }

    // Check if the conversationKey itself is an existing conversation ID.
    // This happens when the client loads a conversation from the conversations list
    // and uses the server's conversationId as its local conversationKey.
    const existingConversation = tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, conversationKey))
      .get();

    if (existingConversation) {
      tx.insert(conversationKeys)
        .values({
          id: uuid(),
          conversationKey,
          conversationId: existingConversation.id,
          createdAt: Date.now(),
        })
        .run();
      const conv = tx
        .select({ conversationType: conversations.conversationType })
        .from(conversations)
        .where(eq(conversations.id, existingConversation.id))
        .get();
      return {
        conversationId: existingConversation.id,
        conversationType: conv?.conversationType ?? "standard",
        created: false as const,
      };
    }

    const now = Date.now();
    const conversationId = uuid();
    const title = GENERATING_TITLE;
    const memoryScopeId =
      conversationType === "private"
        ? `private:${conversationId}`
        : deriveChannelScope(conversationKey);

    tx.insert(conversations)
      .values({
        id: conversationId,
        title,
        createdAt: now,
        updatedAt: now,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalEstimatedCost: 0,
        contextSummary: null,
        contextCompactedMessageCount: 0,
        contextCompactedAt: null,
        conversationType,
        memoryScopeId,
      })
      .run();

    tx.insert(conversationKeys)
      .values({
        id: uuid(),
        conversationKey,
        conversationId,
        createdAt: now,
      })
      .run();

    return {
      conversationId,
      conversationType,
      created: true as const,
      conversation: {
        id: conversationId,
        title,
        createdAt: now,
        conversationType,
      },
    };
  });

  if (result.created) {
    initConversationDir({ ...result.conversation, originChannel: null });
  }

  return {
    conversationId: result.conversationId,
    conversationType: result.conversationType,
    created: result.created,
  };
}
