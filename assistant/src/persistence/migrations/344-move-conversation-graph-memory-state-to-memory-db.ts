import type { Database } from "bun:sqlite";

import { getMemoryDbPath } from "../../util/memory-db-path.js";
import type { DrizzleDb } from "../db-connection.js";
import {
  type RelocationSpec,
  runMemoryTableRelocation,
} from "./helpers/relocation.js";

/**
 * How to drain `conversation_graph_memory_state` from `main` into the memory
 * DB. Every row is copied: one row per conversation holds the
 * ConversationGraphMemory + InContextTracker snapshot rehydrated on resume.
 */
export const CONVERSATION_GRAPH_MEMORY_STATE_RELOCATION: RelocationSpec = {
  table: "conversation_graph_memory_state",
  targetDbPath: getMemoryDbPath,
  columns: ["conversation_id", "state_json", "created_at", "updated_at"],
};

/**
 * Create the `conversation_graph_memory_state` table on the memory connection.
 * Idempotent (`IF NOT EXISTS`) — the dedicated connection performs no DDL on
 * open, so this migration owns the schema.
 *
 * The `REFERENCES conversations(id) ON DELETE CASCADE` clause migration 207
 * declared in the main DB is dropped here: SQLite foreign keys cannot span
 * database files, and the memory DB has no `conversations` table. The lost
 * cascade is replaced by an explicit delete on the memory connection in the
 * memory plugin's `conversation-deleted` hook.
 */
export function ensureConversationGraphMemoryStateSchema(
  memoryRaw: Database,
): void {
  memoryRaw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS conversation_graph_memory_state (
      conversation_id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

/**
 * Move `conversation_graph_memory_state` — the per-conversation graph-memory
 * tracker snapshot — into the dedicated memory database
 * (`assistant-memory.db`), so its store reads/writes ride the memory
 * connection.
 *
 * Registered with `dependsOn` on migration 207 (creator) and 229
 * (`migrateDeletePrivateConversations`), so the move never outruns either on a
 * database where they are still pending. 229 purges private rows through the
 * main-DB FK cascade, so moving the table first — dropping the cascade — would
 * let a deferred or retried private delete orphan those snapshots on the memory
 * connection.
 */
export async function migrateMoveConversationGraphMemoryStateToMemoryDb(
  database: DrizzleDb,
): Promise<void> {
  await runMemoryTableRelocation(
    database,
    CONVERSATION_GRAPH_MEMORY_STATE_RELOCATION,
    ensureConversationGraphMemoryStateSchema,
  );
}
