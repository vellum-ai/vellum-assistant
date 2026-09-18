import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

const TABLE = "conversation_mode_sessions";

export function migrateCreateConversationModeSessions(
  database: DrizzleDb,
): void {
  const sqlite = getSqliteFrom(database);
  sqlite.exec(/* sql */ `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      mode TEXT NOT NULL CHECK (mode IN ('computer_use', 'browser', 'live_vision', 'ambient')),
      status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'interrupted')),
      source_started_at INTEGER NOT NULL,
      first_included_at INTEGER,
      first_included_message_id TEXT,
      last_activity_at INTEGER NOT NULL,
      last_owned_message_id TEXT,
      ended_at INTEGER,
      end_reason TEXT,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
      CHECK ((first_included_at IS NULL) = (first_included_message_id IS NULL)),
      CHECK (
        (status = 'active' AND ended_at IS NULL AND end_reason IS NULL)
        OR (status = 'completed' AND ended_at IS NOT NULL AND end_reason IS NOT NULL AND length(end_reason) > 0)
        OR (status = 'interrupted' AND end_reason IS NOT NULL AND length(end_reason) > 0)
      ),
      CHECK (ended_at IS NULL OR ended_at >= last_activity_at),
      CHECK (last_activity_at >= source_started_at),
      CHECK (first_included_at IS NULL OR first_included_at <= last_activity_at)
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_mode_sessions_conversation_status
      ON ${TABLE} (conversation_id, status);
  `);
}

export function downCreateConversationModeSessions(database: DrizzleDb): void {
  getSqliteFrom(database).exec(`DROP TABLE IF EXISTS ${TABLE}`);
}
