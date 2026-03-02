import { randomUUID } from "node:crypto";

import { getDb } from "./db.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConversationRow {
  id: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface MessageRow {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  createdAt: number;
}

export interface ConversationKeyRow {
  id: string;
  conversationKey: string;
  conversationId: string;
  createdAt: number;
}

/**
 * A normalized conversation ready for import.
 *
 * `sourceKey` is an optional deduplication identifier (e.g. `"chatgpt:abc123"`).
 * When provided, importing a conversation with an already-recorded key is a no-op.
 */
export interface ImportableConversation {
  /** Deduplication key, e.g. `"chatgpt:abc123"`. Optional. */
  sourceKey?: string;
  title: string;
  /** Unix epoch milliseconds */
  createdAt: number;
  /** Unix epoch milliseconds */
  updatedAt: number;
  messages: ImportableMessage[];
}

/**
 * A single message within an importable conversation.
 *
 * `content` may be a plain string or a structured content array
 * (e.g. `[{ type: "text", text: "Hello" }]`). Arrays are JSON-serialised
 * before storage to match the format produced by the assistant runtime.
 */
export interface ImportableMessage {
  role: string;
  content: string | Array<{ type: string; text: string }>;
  /** Unix epoch milliseconds */
  createdAt: number;
}

export interface ImportResult {
  importedCount: number;
  skippedCount: number;
  messageCount: number;
}

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

let lastTimestamp = 0;

function monotonicNow(): number {
  const now = Date.now();
  lastTimestamp = Math.max(now, lastTimestamp + 1);
  return lastTimestamp;
}

// ---------------------------------------------------------------------------
// Conversation CRUD
// ---------------------------------------------------------------------------

/**
 * Create a new conversation record and return it.
 */
export function createConversation(
  title: string,
  createdAt?: number,
  updatedAt?: number,
): ConversationRow {
  const db = getDb();
  const now = Date.now();
  const row: ConversationRow = {
    id: randomUUID(),
    title,
    createdAt: createdAt ?? now,
    updatedAt: updatedAt ?? now,
  };
  db.prepare(
    `INSERT INTO conversations (
       id, title, created_at, updated_at,
       total_input_tokens, total_output_tokens, total_estimated_cost,
       context_compacted_message_count, thread_type, memory_scope_id
     ) VALUES (?, ?, ?, ?, 0, 0, 0, 0, 'standard', 'default')`,
  ).run(row.id, row.title, row.createdAt, row.updatedAt);
  return row;
}

/**
 * Add a message to an existing conversation.
 * When `createdAt` is omitted a monotonically-increasing timestamp is used.
 */
export function addMessage(
  conversationId: string,
  role: string,
  content: string,
  createdAt?: number,
): MessageRow {
  const db = getDb();
  const ts = createdAt ?? monotonicNow();
  const row: MessageRow = {
    id: randomUUID(),
    conversationId,
    role,
    content,
    createdAt: ts,
  };
  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(row.id, row.conversationId, row.role, row.content, row.createdAt);
  db.prepare(
    `UPDATE conversations SET updated_at = ? WHERE id = ?`,
  ).run(ts, conversationId);
  return row;
}

// ---------------------------------------------------------------------------
// Conversation-key helpers (deduplication)
// ---------------------------------------------------------------------------

/**
 * Look up a conversation key record. Returns `null` when not found.
 */
export function findConversationKey(key: string): ConversationKeyRow | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, conversation_key, conversation_id, created_at
       FROM conversation_keys WHERE conversation_key = ?`,
    )
    .get(key) as
    | {
        id: string;
        conversation_key: string;
        conversation_id: string;
        created_at: number;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    conversationKey: row.conversation_key,
    conversationId: row.conversation_id,
    createdAt: row.created_at,
  };
}

/**
 * Record a deduplication key that maps to an existing conversation.
 */
export function createConversationKey(
  key: string,
  conversationId: string,
): ConversationKeyRow {
  const db = getDb();
  const now = Date.now();
  const row: ConversationKeyRow = {
    id: randomUUID(),
    conversationKey: key,
    conversationId,
    createdAt: now,
  };
  db.prepare(
    `INSERT INTO conversation_keys (id, conversation_key, conversation_id, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(row.id, row.conversationKey, row.conversationId, row.createdAt);
  return row;
}

/**
 * List all recorded conversation keys, newest first.
 */
export function listConversationKeys(limit = 100): ConversationKeyRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, conversation_key, conversation_id, created_at
       FROM conversation_keys
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{
    id: string;
    conversation_key: string;
    conversation_id: string;
    created_at: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    conversationKey: r.conversation_key,
    conversationId: r.conversation_id,
    createdAt: r.created_at,
  }));
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/**
 * List conversations ordered by most recently updated.
 */
export function listConversations(limit = 50): ConversationRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, title, created_at, updated_at
       FROM conversations
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{
    id: string;
    title: string | null;
    created_at: number;
    updated_at: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

// ---------------------------------------------------------------------------
// High-level import
// ---------------------------------------------------------------------------

/**
 * Import an array of conversations into the database.
 *
 * Conversations with a `sourceKey` that already exists in `conversation_keys`
 * are silently skipped (idempotent re-import).
 *
 * Each conversation is imported atomically: if any write fails the entire
 * conversation is rolled back, preventing partial data and duplicate-key
 * collisions on retry.
 */
export function importConversations(
  conversations: ImportableConversation[],
): ImportResult {
  const db = getDb();
  let importedCount = 0;
  let skippedCount = 0;
  let messageCount = 0;

  const importOne = db.transaction((conv: ImportableConversation) => {
    // Deduplication check (inside the transaction for isolation)
    if (conv.sourceKey) {
      const existing = findConversationKey(conv.sourceKey);
      if (existing) {
        return false;
      }
    }

    const conversation = createConversation(
      conv.title,
      conv.createdAt,
      conv.updatedAt,
    );

    for (const msg of conv.messages) {
      const content =
        typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content);
      addMessage(conversation.id, msg.role, content, msg.createdAt);
    }

    // Restore the intended updatedAt — addMessage overwrites it with each
    // message's timestamp, which may not reflect the conversation's true
    // last-updated time.
    db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(
      conv.updatedAt,
      conversation.id,
    );

    if (conv.sourceKey) {
      createConversationKey(conv.sourceKey, conversation.id);
    }

    return conv.messages.length;
  });

  for (const conv of conversations) {
    const result = importOne(conv);
    if (result === false) {
      skippedCount++;
    } else {
      importedCount++;
      messageCount += result;
    }
  }

  return { importedCount, skippedCount, messageCount };
}
