import type { Database } from "bun:sqlite";

import { getMemoryDbPath } from "../../util/memory-db-path.js";
import type { DrizzleDb } from "../db-connection.js";
import {
  type RelocationSpec,
  runMemoryTableRelocation,
} from "./helpers/relocation.js";

/**
 * How to drain `memory_retrospective_state` from `main` into the memory DB.
 * Full copy — one row per source conversation tracks the retrospective job's
 * pointers and cumulative remembered log, all worth preserving. A legacy
 * source that predates migration 281 has no `remembered_log` column, so the
 * drain NULL-fills it (see `drainStagedTable`).
 */
export const MEMORY_RETROSPECTIVE_STATE_RELOCATION: RelocationSpec = {
  table: "memory_retrospective_state",
  targetDbPath: getMemoryDbPath,
  columns: [
    "conversation_id",
    "last_processed_message_id",
    "last_run_at",
    "remembered_log",
  ],
};

/**
 * Create the `memory_retrospective_state` table on the memory connection with
 * the schema from migration 245 plus the `remembered_log` column added by
 * migration 281, but WITHOUT the `REFERENCES conversations(id) ON DELETE
 * CASCADE` clause — SQLite foreign keys cannot span database files, and the
 * memory DB has no `conversations` table. The lost cascade is replaced by the
 * explicit delete in the `conversation-deleted` hook. Idempotent
 * (`IF NOT EXISTS`); exported so tests can stand up the memory-side schema
 * without running the full drain.
 */
export function ensureMemoryRetrospectiveStateSchema(
  memoryRaw: Database,
): void {
  memoryRaw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_retrospective_state (
      conversation_id TEXT PRIMARY KEY,
      last_processed_message_id TEXT NOT NULL,
      last_run_at INTEGER NOT NULL,
      remembered_log TEXT
    )
  `);
}

/**
 * Move `memory_retrospective_state` — the per-conversation retrospective job
 * pointers and remembered log — into the dedicated memory database
 * (`assistant-memory.db`). The main-DB delete cascade that previously collected
 * a state row with its source conversation stops firing once the table lives in
 * a separate file, so the memory `conversation-deleted` hook now purges it
 * explicitly.
 */
export async function migrateMoveMemoryRetrospectiveStateToMemoryDb(
  database: DrizzleDb,
): Promise<void> {
  await runMemoryTableRelocation(
    database,
    MEMORY_RETROSPECTIVE_STATE_RELOCATION,
    ensureMemoryRetrospectiveStateSchema,
  );
}
