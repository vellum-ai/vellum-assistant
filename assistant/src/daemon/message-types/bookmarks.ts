// Bookmark events. Surfaced over SSE so a `BookmarkStore` instance in any
// connected client can stay in sync when another window mutates the list.

import type { BookmarkSummary } from "../../memory/bookmark-crud.js";

export interface BookmarkCreated {
  type: "bookmark.created";
  bookmark: BookmarkSummary;
}

export interface BookmarkDeleted {
  type: "bookmark.deleted";
  messageId: string;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _BookmarksServerMessages = BookmarkCreated | BookmarkDeleted;
