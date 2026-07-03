import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

/**
 * Persist ConversationGraphMemory + InContextTracker state across eviction.
 * Idempotent — uses CREATE TABLE IF NOT EXISTS.
 */
export function migrateCreateConversationGraphMemoryState(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);
  raw.exec(`
    CREATE TABLE IF NOT EXISTS conversation_graph_memory_state (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      state_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}
