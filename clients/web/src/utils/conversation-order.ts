/**
 * The one order every conversation list is in, and how to place a row into it.
 *
 * Recency, newest first. Nothing writes `display_order` any more (LUM-3108),
 * so every section (Pinned, the custom groups, the channels, Chats) is
 * sorted by `lastMessageAt` descending, on the server and here.
 *
 * Extracted because the comparator had grown three copies (the list fetchers'
 * sort, the sidebar's derived bucketing, and now local placement) and they
 * have to agree: a locally inserted row that sorts differently from the way
 * the server would return it jumps position the moment the list refetches.
 */

import type { Conversation } from "@/types/conversation-types";

/** Sort conversations descending by a timestamp field (newest first). */
export function byTimestampDesc(
  key: "lastMessageAt" | "archivedAt",
): (a: Conversation, b: Conversation) => number {
  return (a, b) => (b[key] ?? 0) - (a[key] ?? 0);
}

/**
 * Recency order, newest first.
 *
 * No tiebreak. `Array.prototype.sort` is stable, so rows sharing a
 * `lastMessageAt` (or both missing one) keep the order they arrived in, which
 * is the server's. Adding an id tiebreak here would reorder them against it.
 */
export const compareByRecency = byTimestampDesc("lastMessageAt");

/**
 * `conversations` with `conversation` inserted at its recency position.
 *
 * Insertion rather than append-and-sort: the list is already ordered, and
 * re-sorting would re-seat rows the server had deliberately placed (equal
 * timestamps hold the server's arrival order, which a full sort of a
 * partially-rebuilt array does not preserve).
 *
 * Ties place the new row *first*, matching what the server does with a row
 * whose timestamp did not change: a just-touched conversation leads the rows
 * it ties with.
 */
export function insertByRecency(
  conversations: readonly Conversation[],
  conversation: Conversation,
): Conversation[] {
  const at = conversations.findIndex(
    (c) => compareByRecency(conversation, c) <= 0,
  );
  const index = at === -1 ? conversations.length : at;
  return [
    ...conversations.slice(0, index),
    conversation,
    ...conversations.slice(index),
  ];
}
