import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_acp_session_history_v1";

/**
 * Create the acp_session_history table for persisting completed ACP
 * (Agent Client Protocol) sessions so the sessions UI has data across
 * daemon restarts.
 */
export function migrate230AcpSessionHistory(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS acp_session_history (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        acp_session_id TEXT NOT NULL,
        parent_conversation_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        status TEXT NOT NULL,
        stop_reason TEXT,
        error TEXT,
        event_log_json TEXT NOT NULL DEFAULT '[]'
      )
    `);

    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_acp_session_history_started_at
      ON acp_session_history (started_at DESC)
    `);

    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_acp_session_history_parent_conversation_id
      ON acp_session_history (parent_conversation_id)
    `);
  });
}
