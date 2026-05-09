import { desc, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import type { DrizzleDb } from "./db-connection.js";
import {
  conversations,
  type MessageBookmarkRow,
  messageBookmarks,
  messages,
} from "./schema.js";

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

function buildPreview(content: string): string {
  return content.length > PREVIEW_MAX_CHARS
    ? content.slice(0, PREVIEW_MAX_CHARS)
    : content;
}

/**
 * List all bookmarks newest-first, joined against `messages` and
 * `conversations`. Bookmarks whose parent message or conversation has
 * been deleted are naturally excluded by the inner-join semantics; the
 * `ON DELETE CASCADE` on the FKs means rows should never end up in this
 * orphan state, but the join provides a defense-in-depth guarantee.
 */
export function listBookmarks(db: DrizzleDb): BookmarkSummary[] {
  const rows = db
    .select({
      id: messageBookmarks.id,
      messageId: messageBookmarks.messageId,
      conversationId: messageBookmarks.conversationId,
      createdAt: messageBookmarks.createdAt,
      conversationTitle: conversations.title,
      messageContent: messages.content,
      messageRole: messages.role,
      messageCreatedAt: messages.createdAt,
    })
    .from(messageBookmarks)
    .innerJoin(messages, eq(messages.id, messageBookmarks.messageId))
    .innerJoin(
      conversations,
      eq(conversations.id, messageBookmarks.conversationId),
    )
    .orderBy(desc(messageBookmarks.createdAt))
    .all();

  return rows.map((row) => ({
    id: row.id,
    messageId: row.messageId,
    conversationId: row.conversationId,
    conversationTitle: row.conversationTitle,
    messagePreview: buildPreview(row.messageContent),
    messageRole: row.messageRole,
    messageCreatedAt: row.messageCreatedAt,
    createdAt: row.createdAt,
  }));
}

/**
 * Fetch a single bookmark by id in the same JOIN-shaped form as
 * {@link listBookmarks}. Returns `null` if no row matches.
 */
export function getBookmarkSummary(
  db: DrizzleDb,
  id: string,
): BookmarkSummary | null {
  const row = db
    .select({
      id: messageBookmarks.id,
      messageId: messageBookmarks.messageId,
      conversationId: messageBookmarks.conversationId,
      createdAt: messageBookmarks.createdAt,
      conversationTitle: conversations.title,
      messageContent: messages.content,
      messageRole: messages.role,
      messageCreatedAt: messages.createdAt,
    })
    .from(messageBookmarks)
    .innerJoin(messages, eq(messages.id, messageBookmarks.messageId))
    .innerJoin(
      conversations,
      eq(conversations.id, messageBookmarks.conversationId),
    )
    .where(eq(messageBookmarks.id, id))
    .get();
  if (!row) return null;
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

/**
 * Create a bookmark for the given message, returning the row. Idempotent
 * on the unique `message_id` index — if a bookmark already exists for
 * `messageId`, the existing row is returned and no new row is inserted.
 */
export function createBookmark(
  db: DrizzleDb,
  params: { messageId: string; conversationId: string },
): MessageBookmarkRow {
  const { messageId, conversationId } = params;
  const existing = db
    .select()
    .from(messageBookmarks)
    .where(eq(messageBookmarks.messageId, messageId))
    .get();
  if (existing) return existing;

  const row: MessageBookmarkRow = {
    id: uuid(),
    messageId,
    conversationId,
    createdAt: Date.now(),
  };

  try {
    db.insert(messageBookmarks).values(row).run();
    return row;
  } catch (err) {
    // Lost a race against a concurrent create — fall back to fetch.
    const winner = db
      .select()
      .from(messageBookmarks)
      .where(eq(messageBookmarks.messageId, messageId))
      .get();
    if (winner) return winner;
    throw err;
  }
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

/**
 * True iff a bookmark exists for the given `messageId`.
 */
export function isMessageBookmarked(db: DrizzleDb, messageId: string): boolean {
  const row = db
    .select({ id: messageBookmarks.id })
    .from(messageBookmarks)
    .where(eq(messageBookmarks.messageId, messageId))
    .get();
  return row != null;
}
