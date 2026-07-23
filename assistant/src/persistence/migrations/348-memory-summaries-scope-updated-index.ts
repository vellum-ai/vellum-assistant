import type { DrizzleDb } from "../db-connection.js";

/**
 * Add an index on `memory_summaries(scope, updated_at DESC)` to support the
 * recent-summaries fetch on context load
 * (`ConversationGraphMemory.fetchRecentSummaries`).
 *
 * That query filters `scope = 'conversation'` and orders by `updated_at DESC`
 * with a small `LIMIT`, joining `conversations` only to read
 * `conversation_type`. The existing summary indexes cover `(scope, scope_key)`
 * and `(scope, end_at DESC)` but none provides `updated_at` order, so SQLite
 * had to materialize and sort the entire `scope = 'conversation'` partition on
 * every context load (observed ~2.2s for a 3-row result). This composite index
 * lets the planner walk the partition newest-first and stop after the first few
 * qualifying rows, eliminating the sort and enabling early termination.
 *
 * Idempotent: `CREATE INDEX IF NOT EXISTS`.
 */
export function migrateMemorySummariesScopeUpdatedIndex(
  database: DrizzleDb,
): void {
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_summaries_scope_updated ON memory_summaries(scope, updated_at DESC)`,
  );
}
