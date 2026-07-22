// Bookmark events. Surfaced over SSE so a `BookmarkStore` instance in any
// connected client can stay in sync when another window mutates the list.
//
// Server→client events are single-sourced from their canonical `api/events`
// wire schemas; this file only composes them into the domain union consumed by
// `message-protocol.ts`.

import type { BookmarkCreatedEvent } from "../../api/events/bookmark-created.js";
import type { BookmarkDeletedEvent } from "../../api/events/bookmark-deleted.js";

export type _BookmarksServerMessages =
  | BookmarkCreatedEvent
  | BookmarkDeletedEvent;
