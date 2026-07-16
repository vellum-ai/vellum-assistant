import type { Database } from "bun:sqlite";

import { getMemoryDbPath } from "../../util/memory-db-path.js";
import type { DrizzleDb } from "../db-connection.js";
import {
  type RelocationSpec,
  runMemoryTableRelocation,
} from "./helpers/relocation.js";

/**
 * How to drain `activation_state` from `main` into the memory DB. Every row is
 * copied: one row per conversation captures the latest v2 activation snapshot,
 * rehydrated for the conversation's whole lifetime.
 */
export const ACTIVATION_STATE_RELOCATION: RelocationSpec = {
  table: "activation_state",
  targetDbPath: getMemoryDbPath,
  columns: [
    "conversation_id",
    "message_id",
    "state_json",
    "ever_injected_json",
    "current_turn",
    "updated_at",
  ],
};

/**
 * Create the `activation_state` table on the memory connection. Idempotent
 * (`IF NOT EXISTS`) — the dedicated connection performs no DDL on open, so this
 * migration owns the schema.
 *
 * The `REFERENCES conversations(id) ON DELETE CASCADE` clause migration 241
 * added in the main DB is dropped here: SQLite foreign keys cannot span
 * database files, and the memory DB has no `conversations` table. The lost
 * cascade is replaced by an explicit delete on the memory connection in the
 * memory plugin's `conversation-deleted` hook.
 */
export function ensureActivationStateSchema(memoryRaw: Database): void {
  memoryRaw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS activation_state (
      conversation_id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      state_json TEXT NOT NULL,
      ever_injected_json TEXT NOT NULL DEFAULT '[]',
      current_turn INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    )
  `);
}

/**
 * Move `activation_state` — the per-conversation v2 activation snapshot — into
 * the dedicated memory database (`assistant-memory.db`), joining the memory
 * plugin's other relocated state so its store reads/writes ride the memory
 * connection.
 *
 * Registered with `dependsOn` on migrations 232 (creator) and 241 (which
 * rebuilds the table to add the FK cascade), so the move never outruns either
 * on a database where they are still pending.
 */
export async function migrateMoveActivationStateToMemoryDb(
  database: DrizzleDb,
): Promise<void> {
  await runMemoryTableRelocation(
    database,
    ACTIVATION_STATE_RELOCATION,
    ensureActivationStateSchema,
  );
}
