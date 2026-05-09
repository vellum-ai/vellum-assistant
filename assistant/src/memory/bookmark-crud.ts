import { desc, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import type { DrizzleDb } from "./db-connection.js";
import { stringifyMessageContent } from "./message-content.js";
import { conversations, messageBookmarks, messages } from "./schema.js";

/**
 * Wire-shape representation of a bookmark, joined with the bookmarked
 * message and its parent conversation. Mirrors
 * `clients/shared/Network/BookmarkSummary.swift` — dates are emitted as
 * unix-millisecond integers, and the message preview is capped to keep
 * the list payload bounded.
 */
export interface BookmarkSummary {
  id: string;
  messageId: string;
  conversationId: string;
  conversationTitle: string | null;
  messagePreview: string;
  /** "user" | "assistant" — kept as a free-form string so it round-trips raw. */
  messageRole: string;
  /** Unix milliseconds. */
  messageCreatedAt: number;
  /** Unix milliseconds. */
  createdAt: number;
}

const PREVIEW_MAX_CHARS = 240;

/**
 * Decode the on-disk message content (legacy plain string OR JSON-serialized
 * `ContentBlock[]`) into a single text string and cap it at
 * `PREVIEW_MAX_CHARS`. Without the decode step, modern rows would render as
 * raw JSON in the bookmark list.
 */
function buildPreview(content: string): string {
  const text = stringifyMessageContent(content);
  return text.length > PREVIEW_MAX_CHARS
    ? text.slice(0, PREVIEW_MAX_CHARS)
    : text;
}

/**
 * Shared SELECT shape used by the JOIN-based readers. Pulling this out
 * avoids duplicating the column list and the row-mapping below.
 */
const BOOKMARK_JOIN_COLUMNS = {
  id: messageBookmarks.id,
  messageId: messageBookmarks.messageId,
  conversationId: messageBookmarks.conversationId,
  createdAt: messageBookmarks.createdAt,
  conversationTitle: conversations.title,
  messageContent: messages.content,
  messageRole: messages.role,
  messageCreatedAt: messages.createdAt,
} as const;

type BookmarkJoinRow = {
  id: string;
  messageId: string;
  conversationId: string;
  createdAt: number;
  conversationTitle: string | null;
  messageContent: string;
  messageRole: string;
  messageCreatedAt: number;
};

function rowToSummary(row: BookmarkJoinRow): BookmarkSummary {
  return {
    id: row.id,
    messageId: row.messageId,
    conversationId: row.conversationId,
    conversationTitle: row.conversationTitle,
    messagePreview: buildPreview(row.messageContent),
    messageRole: row.messageRole,
    messageCreatedAt: row.messageCreatedAt,
    createdAt: row.createdAt,
  };
}

function selectBookmarkJoin(db: DrizzleDb) {
  return db
    .select(BOOKMARK_JOIN_COLUMNS)
    .from(messageBookmarks)
    .innerJoin(messages, eq(messages.id, messageBookmarks.messageId))
    .innerJoin(
      conversations,
      eq(conversations.id, messageBookmarks.conversationId),
    );
}

/**
 * List all bookmarks newest-first, joined against `messages` and
 * `conversations`. Bookmarks whose parent message or conversation has
 * been deleted are naturally excluded by the inner-join semantics; the
 * `ON DELETE CASCADE` on the FKs means rows should never end up in this
 * orphan state, but the join provides a defense-in-depth guarantee.
 */
export function listBookmarks(db: DrizzleDb): BookmarkSummary[] {
  const rows = selectBookmarkJoin(db)
    .orderBy(desc(messageBookmarks.createdAt))
    .all();
  return rows.map(rowToSummary);
}

/**
 * Create a bookmark for the given message and return its JOIN-shaped
 * {@link BookmarkSummary}. Idempotent on the unique `message_id` index —
 * if a bookmark already exists for `messageId`, the existing summary is
 * returned and no new row is inserted.
 */
export function createBookmark(
  db: DrizzleDb,
  params: { messageId: string; conversationId: string },
): BookmarkSummary {
  const { messageId, conversationId } = params;
  const existing = db
    .select({ id: messageBookmarks.id })
    .from(messageBookmarks)
    .where(eq(messageBookmarks.messageId, messageId))
    .get();
  if (existing) return readBookmarkSummaryOrThrow(db, existing.id);

  const id = uuid();
  try {
    db.insert(messageBookmarks)
      .values({ id, messageId, conversationId, createdAt: Date.now() })
      .run();
  } catch (err) {
    // Lost a race against a concurrent create — fall back to fetch by
    // messageId so we still return the winning row.
    const winner = db
      .select({ id: messageBookmarks.id })
      .from(messageBookmarks)
      .where(eq(messageBookmarks.messageId, messageId))
      .get();
    if (!winner) throw err;
    return readBookmarkSummaryOrThrow(db, winner.id);
  }
  return readBookmarkSummaryOrThrow(db, id);
}

function readBookmarkSummaryOrThrow(
  db: DrizzleDb,
  id: string,
): BookmarkSummary {
  const row = selectBookmarkJoin(db).where(eq(messageBookmarks.id, id)).get();
  if (!row) {
    // Unreachable: caller just observed (or inserted) this id.
    throw new Error(`Bookmark ${id} disappeared between insert and read`);
  }
  return rowToSummary(row);
}

/**
 * Delete a bookmark by id. Returns true iff a row was removed.
 *
 * Drizzle's high-level `.run()` is typed as `void` for the sync sqlite
 * driver, so we check existence with a follow-up SELECT instead of
 * relying on a row-count from the delete statement.
 */
export function deleteBookmark(db: DrizzleDb, id: string): boolean {
  const existed = db
    .select({ id: messageBookmarks.id })
    .from(messageBookmarks)
    .where(eq(messageBookmarks.id, id))
    .get();
  if (!existed) return false;
  db.delete(messageBookmarks).where(eq(messageBookmarks.id, id)).run();
  return true;
}

/**
 * Delete the bookmark (if any) attached to the given `messageId`.
 * Returns true iff a row was removed.
 */
export function deleteBookmarkByMessageId(
  db: DrizzleDb,
  messageId: string,
): boolean {
  const existed = db
    .select({ id: messageBookmarks.id })
    .from(messageBookmarks)
    .where(eq(messageBookmarks.messageId, messageId))
    .get();
  if (!existed) return false;
  db.delete(messageBookmarks)
    .where(eq(messageBookmarks.messageId, messageId))
    .run();
  return true;
}
