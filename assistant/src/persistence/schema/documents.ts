import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { conversations } from "./conversations.js";

export const documents = sqliteTable(
  "documents",
  {
    surfaceId: text("surface_id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    content: text("content").notNull(),
    wordCount: integer("word_count").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    // Unused by the daemon: no code reads or writes the column, and some rows
    // carry a non-NULL path. It stays in the model because migration 360 puts
    // it in the physical table and the model must keep describing that table.
    workspacePath: text("workspace_path"),
  },
  (table) => [
    // Partial, so the NULL rows stay unconstrained.
    uniqueIndex("idx_documents_workspace_path")
      .on(table.workspacePath)
      .where(sql`workspace_path IS NOT NULL`),
  ],
);

// Junction table mapping a document surface to every conversation it appears in.
export const documentConversations = sqliteTable(
  "document_conversations",
  {
    surfaceId: text("surface_id")
      .notNull()
      .references(() => documents.surfaceId, { onDelete: "cascade" }),
    conversationId: text("conversation_id").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.surfaceId, table.conversationId] }),
    index("idx_doc_conv_conversation_id").on(table.conversationId),
  ],
);

export const documentComments = sqliteTable(
  "document_comments",
  {
    id: text("id").primaryKey(),
    surfaceId: text("surface_id")
      .notNull()
      .references(() => documents.surfaceId, { onDelete: "cascade" }),
    conversationId: text("conversation_id").notNull(),
    author: text("author").notNull(),
    content: text("content").notNull(),
    anchorStart: integer("anchor_start"),
    anchorEnd: integer("anchor_end"),
    anchorText: text("anchor_text"),
    // Self-referential parent link (threaded replies). The FK to
    // document_comments(id) ON DELETE CASCADE is enforced at the DB level.
    parentCommentId: text("parent_comment_id"),
    status: text("status").notNull().default("open"),
    resolvedBy: text("resolved_by"),
    resolvedAt: integer("resolved_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_document_comments_surface").on(table.surfaceId),
    index("idx_document_comments_parent").on(table.parentCommentId),
  ],
);
