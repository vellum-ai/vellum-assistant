/**
 * Pure merge/filter/sort helpers for the "View All Conversations" page,
 * split out from the React data hook so they carry no React, TanStack Query,
 * or generated-client imports and can be unit-tested in isolation.
 */

import type { Conversation } from "@/types/conversation-types";

/** Three-way filter across the merged conversation list. Default `all`. */
export type ConversationFilter = "all" | "active" | "archived";

/** A conversation paired with its resolved archived state for the row UI. */
export interface AllConversationsRow {
  conversation: Conversation;
  archived: boolean;
}

/**
 * Whether a conversation reads as archived. A conversation is archived when
 * the daemon stamped `archivedAt`, or when it was sourced from the archived
 * list (which is the authoritative signal — the archived query returns rows
 * the foreground list omits, and some of those may predate `archivedAt`).
 */
function isArchived(
  conversation: Conversation,
  fromArchivedList: boolean,
): boolean {
  return fromArchivedList || conversation.archivedAt != null;
}

/** Most-recently-touched first, matching the sidebar's recency ordering. */
function byMostRecent(a: Conversation, b: Conversation): number {
  const aTime = a.lastMessageAt ?? a.createdAt ?? 0;
  const bTime = b.lastMessageAt ?? b.createdAt ?? 0;
  return bTime - aTime;
}

/**
 * Merge the active and archived lists into a single deduped set of rows.
 *
 * "Active" spans every non-archived source the sidebar can surface —
 * foreground, background, and scheduled — each cached under its own query
 * key, so the page takes them as separate lists and flattens them. Dedupe
 * keys on `conversationId`; when a conversation appears in more than one
 * list the archived list wins the archived flag, since it is the
 * authoritative source for archived state. Rows are returned
 * most-recently-touched first.
 */
export function mergeConversations(
  activeLists: Conversation[][],
  archived: Conversation[],
): AllConversationsRow[] {
  const byId = new Map<string, AllConversationsRow>();

  for (const list of activeLists) {
    for (const conversation of list) {
      // A conversation can appear in more than one active list (e.g. a
      // scheduled job that also shows in the backlog); keep the first and
      // let the archived pass below override the flag if needed.
      if (!byId.has(conversation.conversationId)) {
        byId.set(conversation.conversationId, {
          conversation,
          archived: isArchived(conversation, false),
        });
      }
    }
  }

  for (const conversation of archived) {
    // The archived list is authoritative for the archived flag, so it
    // overwrites any active-list entry for the same conversation.
    byId.set(conversation.conversationId, {
      conversation,
      archived: isArchived(conversation, true),
    });
  }

  return [...byId.values()].sort((a, b) =>
    byMostRecent(a.conversation, b.conversation),
  );
}

/** Apply the All/Active/Archived filter to the merged rows. */
export function filterByState(
  rows: AllConversationsRow[],
  filter: ConversationFilter,
): AllConversationsRow[] {
  if (filter === "active") {
    return rows.filter((row) => !row.archived);
  }
  if (filter === "archived") {
    return rows.filter((row) => row.archived);
  }
  return rows;
}

/** Case-insensitive title match. Rows with no title never match a query. */
export function filterBySearch(
  rows: AllConversationsRow[],
  searchText: string,
): AllConversationsRow[] {
  const query = searchText.trim().toLowerCase();
  if (!query) {
    return rows;
  }
  return rows.filter((row) =>
    (row.conversation.title ?? "").toLowerCase().includes(query),
  );
}
