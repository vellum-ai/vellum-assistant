/**
 * The one order every conversation list is in, and how to place a row into it.
 *
 * Recency, newest first: every section (Pinned, the custom groups, the
 * channels, Chats) is sorted by `lastMessageAt` descending, on the server and
 * here. Nothing consults `display_order` (LUM-3108).
 *
 * One comparator, shared by the list fetchers, the sidebar's derived
 * bucketing, and local placement, because the three have to agree. A locally
 * inserted row that sorts differently from the way the server returns it jumps
 * position the moment the list refetches.
 */

import type { Conversation } from "@/types/conversation-types";
import type { ConversationListPage } from "@/utils/conversation-list-fetchers";

/** Sort conversations descending by a timestamp field (newest first). */
export function byTimestampDesc(
  key: "lastMessageAt" | "archivedAt",
): (a: Conversation, b: Conversation) => number {
  return (a, b) => (b[key] ?? 0) - (a[key] ?? 0);
}

/**
 * Recency order, newest first.
 *
 * This matches the server's sort key exactly, and the reason is one hop
 * away from here: the SQL orders by `COALESCE(last_message_at, updated_at)`
 * (`listConversations` in the daemon's `conversation-queries.ts`), and
 * `toConversation` bakes that same coalesce into `lastMessageAt`
 * (`raw.lastMessageAt ?? raw.updatedAt`), so a row with no messages yet
 * still carries the value the server sorted it by. The `?? 0` fallback can
 * only fire for client-minted draft stubs, which never came from the server
 * and are separately protected wherever this order prunes.
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

/**
 * `page` with `conversation` inserted at its recency position, or `page`
 * unchanged (same reference) when the row belongs past the loaded window.
 *
 * A cache with `hasMore` is a prefix of the true list: rows exist on the
 * server between its last row and the end. A row that sorts strictly below
 * that last row belongs somewhere in the unloaded remainder, so appending it
 * would render it at the wrong position and hide the real page boundary from
 * the load-more path (the appended row would sit where the next fetched page
 * starts). Dropping it is correct because membership is not lost: the row is
 * in this section server-side and scrolls into view through load-more.
 *
 * The empty window inserts even under `hasMore`. It has no last row to
 * compare against, and it only arises transiently, when optimistic removals
 * empty a window whose deeper pages were never loaded; showing the row
 * immediately beats showing nothing, and the next first-page merge re-seats
 * it.
 */
export function insertIntoWindow(
  page: ConversationListPage,
  conversation: Conversation,
): ConversationListPage {
  const { conversations, hasMore } = page;
  const last = conversations[conversations.length - 1];
  if (
    hasMore &&
    last !== undefined &&
    compareByRecency(conversation, last) > 0
  ) {
    return page;
  }
  return {
    conversations: insertByRecency(conversations, conversation),
    hasMore,
  };
}

/**
 * Reconcile one fetched first page into a cached newest-first list.
 *
 * - `hasMore === false`: the page is the complete list, so it replaces the
 *   cache.
 * - Otherwise the fresh rows win, and cached rows absent from the page
 *   survive only when they sort strictly below the page's window (older
 *   than the oldest fresh row). A cached row whose timestamp falls inside
 *   the window but is missing from the page no longer lives there (deleted
 *   or archived), so it is dropped.
 * - Client-local draft rows always survive; the server doesn't know them.
 *
 * `pinnedInjected` says whether this page came from the one request the
 * daemon appends every pinned conversation to (the unfiltered foreground
 * list; the compatibility shim in `handleListConversations`). There the
 * pinned rows are excluded from the cutoff, since an ancient injected pin
 * would collapse it and drop live rows. A section page has no injection
 * (the daemon skips it for every group- and channel-scoped request), so its
 * pinned rows are genuine window members: in the Pinned section every row
 * is pinned, and excluding them would leave no cutoff at all.
 *
 * The fresh window leads the result; surviving rows keep their existing
 * relative order.
 *
 * @internal Exported for testing.
 */
export function mergeListFirstPage(
  prev: ConversationListPage,
  page: ConversationListPage,
  { pinnedInjected }: { pinnedInjected: boolean },
): ConversationListPage {
  if (!page.hasMore) {
    return page;
  }
  const windowRows = pinnedInjected
    ? page.conversations.filter((c) => c.isPinned !== true)
    : page.conversations;
  if (windowRows.length === 0) {
    return prev;
  }
  const cutoff = Math.min(...windowRows.map((c) => c.lastMessageAt ?? 0));
  const freshIds = new Set(page.conversations.map((c) => c.conversationId));
  const kept = prev.conversations.filter(
    (c) =>
      !freshIds.has(c.conversationId) &&
      (c.draft === true || (c.lastMessageAt ?? 0) < cutoff),
  );
  return {
    conversations: [...page.conversations, ...kept],
    hasMore: page.hasMore,
  };
}
