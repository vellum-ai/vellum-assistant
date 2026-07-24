import type { Database } from "bun:sqlite";

import { getMemoryDbPath } from "../../util/memory-db-path.js";
import type { DrizzleDb } from "../db-connection.js";
import {
  type RelocationSpec,
  runMemoryTableRelocation,
} from "./helpers/relocation.js";

/**
 * How to drain `memory_summaries` from `main` into the dedicated memory
 * database — the last table of the memory-DB cutover.
 *
 * The column list is explicit: the base `CREATE` columns (migration 000) plus
 * `version` and `scope_id` (both added by migration 102). `scope_id` is a real
 * `NOT NULL DEFAULT 'default'` column that the Drizzle schema does not map, so
 * dropping it here would lose that data on the drain. `memory_summaries` has no
 * foreign key (its `UNIQUE (scope, scope_key)` is its only constraint), so there
 * is no cascade to replace; it is scope-keyed, not conversation-keyed, so it
 * does NOT join `CONVERSATION_KEYED_MEMORY_TABLES`.
 */
export const MEMORY_SUMMARIES_RELOCATION: RelocationSpec = {
  table: "memory_summaries",
  targetDbPath: getMemoryDbPath,
  columns: [
    "id",
    "scope",
    "scope_key",
    "summary",
    "token_estimate",
    "start_at",
    "end_at",
    "created_at",
    "updated_at",
    "version",
    "scope_id",
  ],
};

/**
 * Create `memory_summaries` on the memory connection. Idempotent. Recreates the
 * inline `UNIQUE (scope, scope_key)` constraint so `ON CONFLICT` upserts resolve
 * exactly as they did on main, plus the scope/scope_id/scope_updated lookup
 * indexes (migrations 018, 104, 348).
 */
export function ensureMemorySummariesSchema(memoryRaw: Database): void {
  memoryRaw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_summaries (
      id             TEXT PRIMARY KEY,
      scope          TEXT NOT NULL,
      scope_key      TEXT NOT NULL,
      summary        TEXT NOT NULL,
      token_estimate INTEGER NOT NULL,
      start_at       INTEGER NOT NULL,
      end_at         INTEGER NOT NULL,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      version        INTEGER NOT NULL DEFAULT 1,
      scope_id       TEXT NOT NULL DEFAULT 'default',
      UNIQUE (scope, scope_key)
    );

    CREATE INDEX IF NOT EXISTS idx_memory_summaries_scope_updated
      ON memory_summaries(scope, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_summaries_scope_time
      ON memory_summaries(scope, end_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_summaries_scope_id
      ON memory_summaries(scope_id);
  `);
}

/**
 * Move `memory_summaries` into the dedicated memory database
 * (`assistant-memory.db`), so the summarizer writer and every reader ride the
 * memory connection. `fetchRecentSummaries` reads it there for step 1 of its
 * two-step and looks up conversationType on the main connection for step 2.
 */
export async function migrateMoveMemorySummariesToMemoryDb(
  database: DrizzleDb,
): Promise<void> {
  await runMemoryTableRelocation(
    database,
    MEMORY_SUMMARIES_RELOCATION,
    ensureMemorySummariesSchema,
  );
}
