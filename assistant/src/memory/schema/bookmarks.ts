import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { conversations, messages } from "./conversations.js";

/**
 * User-saved bookmarks for individual messages. Surfaced in the macOS app
 * Settings → Bookmarks tab and on the message hover overflow menu, behind the
 * `bookmarks` client feature flag.
 *
 * Both foreign keys CASCADE so bookmarks disappear automatically when their
 * parent message or conversation is deleted. A unique index on `message_id`
 * keeps the create-bookmark path idempotent.
 */
export const messageBookmarks = sqliteTable(
  "message_bookmarks",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("message_bookmarks_message_id_uniq").on(table.messageId),
    index("message_bookmarks_created_at_idx").on(table.createdAt),
  ],
);

export type MessageBookmarkRow = typeof messageBookmarks.$inferSelect;
