import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { conversations } from "./conversations.js";

/**
 * The tool definitions a conversation's most recent live turn sent to the
 * provider, serialized exactly as resolved. Written by the per-turn tool
 * resolver when the array changes; read by fork wakes that replay it so their
 * provider prompt-cache prefix matches the source's live turns. Cascades with
 * its conversation.
 */
export const conversationToolSurfaces = sqliteTable(
  "conversation_tool_surfaces",
  {
    conversationId: text("conversation_id")
      .primaryKey()
      .references(() => conversations.id, { onDelete: "cascade" }),
    toolsJson: text("tools_json").notNull(),
    toolsHash: text("tools_hash").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
);
