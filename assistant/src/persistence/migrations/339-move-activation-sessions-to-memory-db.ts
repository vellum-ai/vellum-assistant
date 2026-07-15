import type { Database } from "bun:sqlite";

import { getMemoryDbPath } from "../../util/memory-db-path.js";
import type { DrizzleDb } from "../db-connection.js";
import {
  type RelocationSpec,
  runMemoryTableRelocation,
} from "./helpers/relocation.js";

/**
 * How to drain `activation_sessions` from `main` into the memory DB. Every
 * row is copied: the table is one row per activation-rail conversation, read
 * by the activation funnel for the conversation's whole lifetime.
 */
export const ACTIVATION_SESSIONS_RELOCATION: RelocationSpec = {
  table: "activation_sessions",
  targetDbPath: getMemoryDbPath,
  columns: ["conversation_id", "created_at"],
};

/**
 * Create the `activation_sessions` table on the memory connection. Idempotent
 * (`IF NOT EXISTS`) — the dedicated connection itself performs no DDL on open,
 * so this migration owns the schema. Exported so tests can stand up the
 * memory-side schema without running the full drain.
 */
export function ensureActivationSessionsSchema(memoryRaw: Database): void {
  memoryRaw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS activation_sessions (
      conversation_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    )
  `);
}

/**
 * Move `activation_sessions` — the per-conversation activation-rail marker
 * behind the activation funnel telemetry — into the dedicated memory database
 * (`assistant-memory.db`), joining the memory plugin's other relocated state
 * so its store reads/writes ride the memory connection.
 *
 * On a fresh install the main-side table created by migration 274 is empty,
 * so staging just drops it.
 */
export async function migrateMoveActivationSessionsToMemoryDb(
  database: DrizzleDb,
): Promise<void> {
  await runMemoryTableRelocation(
    database,
    ACTIVATION_SESSIONS_RELOCATION,
    ensureActivationSessionsSchema,
  );
}
