import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * ACP (Agent Client Protocol) session history. Persists completed ACP
 * sessions so the sessions UI has data across daemon restarts.
 *
 * Created by migration 230. Rows are written when a session reaches a
 * terminal state (completed, failed, cancelled).
 */
export const acpSessionHistory = sqliteTable(
  "acp_session_history",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    acpSessionId: text("acp_session_id").notNull(),
    parentConversationId: text("parent_conversation_id").notNull(),
    startedAt: integer("started_at").notNull(),
    completedAt: integer("completed_at"),
    status: text("status").notNull(),
    stopReason: text("stop_reason"),
    error: text("error"),
    eventLogJson: text("event_log_json").notNull().default("[]"),
    // Working directory the agent process was spawned with. Required to
    // resume a persisted session; null for rows written before migration
    // 272 (those sessions are not resumable).
    cwd: text("cwd"),
  },
  (table) => [
    index("idx_acp_session_history_started_at").on(table.startedAt),
    index("idx_acp_session_history_parent_conversation_id").on(
      table.parentConversationId,
    ),
  ],
);
