import {
  index,
  integer,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

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
    // Usage metadata. Null for rows written before these columns existed.
    task: text("task"),
    parentToolUseId: text("parent_tool_use_id"),
    /** Credential failure that ended the run, when one did. Drives the inline
     *  Connect card on reopen; cleared when a replacement token is stored. */
    authErrorCode: text("auth_error_code"),
    authErrorCredential: text("auth_error_credential"),
    usedTokens: integer("used_tokens"),
    contextSize: integer("context_size"),
    costAmount: real("cost_amount"),
    costCurrency: text("cost_currency"),
    // Cumulative input/output tokens across all turns. Null for rows written
    // before these columns existed.
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
  },
  (table) => [
    index("idx_acp_session_history_started_at").on(table.startedAt),
    index("idx_acp_session_history_parent_conversation_id").on(
      table.parentConversationId,
    ),
    // Partial in the database (see migration 373): only rows carrying a
    // credential failure are indexed, which is what keeps the marker lookup a
    // fixed cost rather than one that grows with a conversation's run count.
    // Declared here without the predicate because the schema builder has no
    // way to express one; the migration is the source of truth for its shape.
    index("idx_acp_session_history_auth_marker").on(
      table.parentConversationId,
      table.startedAt,
    ),
  ],
);

/**
 * Claude tokens Claude has refused, by digest.
 *
 * Separate from the session-history marker on purpose: a marker is about
 * showing a card for one run and is deleted with it, while this is about which
 * credential a spawn may resolve and must survive the user clearing history.
 */
export const acpRefusedCredentials = sqliteTable("acp_refused_credentials", {
  digest: text("digest").primaryKey(),
  refusedAt: integer("refused_at").notNull(),
});
