import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

const TABLE = "acp_conversation_model_preference";

/**
 * Create `acp_conversation_model_preference`: which model a conversation's
 * next run on a given agent starts on.
 *
 * Keyed `(parent_conversation_id, agent_id)` because a conversation can drive
 * more than one coding agent and their model vocabularies do not overlap. The
 * conversation column cascades, and no separate index is needed for it: it
 * leads the composite primary key, so the key's own index serves the cascade.
 *
 * Its own table rather than a column on `acp_session_history`, because history
 * answers a different question. History is written once, when a run reaches a
 * terminal state, so it cannot be read before the next run starts and it
 * records whatever the adapter happened to report. A preference is written
 * only when the user chooses, so it never drifts into inheriting a fallback
 * the user never asked for.
 *
 * Idempotent via IF NOT EXISTS.
 */
export function migrateCreateAcpConversationModelPreference(
  database: DrizzleDb,
): void {
  getSqliteFrom(database).exec(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (
       parent_conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
       agent_id TEXT NOT NULL,
       model TEXT NOT NULL,
       updated_at INTEGER NOT NULL,
       PRIMARY KEY (parent_conversation_id, agent_id)
     )`,
  );
}
