import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { conversations } from "./conversations.js";

/**
 * The tool definitions a conversation's most recent live turn sent to the
 * provider, serialized exactly as resolved, plus whether that turn's system
 * prompt rendered the parallel-delegation section (which the prompt derives
 * from the same resolved surface and the turn's channel). Written at the
 * agent loop's send boundary when either changes; read by fork wakes that
 * replay both so their provider prompt-cache prefix matches the source's live
 * turns. Cascades with its conversation.
 */
export const conversationToolSurfaces = sqliteTable(
  "conversation_tool_surfaces",
  {
    conversationId: text("conversation_id")
      .primaryKey()
      .references(() => conversations.id, { onDelete: "cascade" }),
    toolsJson: text("tools_json").notNull(),
    toolsHash: text("tools_hash").notNull(),
    /**
     * Whether the turn's system prompt rendered the `01-parallel-tasks`
     * section. Null when unknown: the turn ran on a system-prompt override,
     * or the row predates the column.
     */
    delegateIndependentTasks: integer("delegate_independent_tasks", {
      mode: "boolean",
    }),
    updatedAt: integer("updated_at").notNull(),
  },
);
