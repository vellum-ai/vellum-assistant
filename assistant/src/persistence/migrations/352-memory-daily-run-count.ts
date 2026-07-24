import type { Database } from "bun:sqlite";

import type { DrizzleDb } from "../db-connection.js";
import { getMemorySqlite } from "../db-connection.js";

/**
 * Create the `memory_daily_run_count` table on the memory connection
 * (`assistant-memory.db`) — one row per `(counter, day_key)` holding a
 * per-UTC-day run tally, namespaced by `counter` so independent daily caps
 * (e.g. automatic consolidation) share one table without colliding. Idempotent
 * (`IF NOT EXISTS`); exported so tests can stand up the memory-side schema
 * directly.
 *
 * The table is not conversation-keyed — it spans every conversation — so it
 * deliberately stays out of `CONVERSATION_KEYED_MEMORY_TABLES`; stale prior-day
 * rows are pruned per counter by the plugin at record time rather than by a
 * delete cascade.
 */
export function ensureMemoryDailyRunCountSchema(memoryRaw: Database): void {
  memoryRaw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_daily_run_count (
      counter TEXT NOT NULL,
      day_key TEXT NOT NULL,
      run_count INTEGER NOT NULL,
      PRIMARY KEY (counter, day_key)
    )
  `);
}

/**
 * Fresh table (no data to relocate), so this only ensures the schema on the
 * memory connection. Throws when the memory database cannot be opened so the
 * runner records the step as failed and retries it on a later boot rather than
 * checkpointing a table that was never created; the throw is caught per-step by
 * the runner, so startup is not aborted.
 */
export function migrateMemoryDailyRunCount(_database: DrizzleDb): void {
  const memoryRaw = getMemorySqlite();
  if (!memoryRaw) {
    throw new Error(
      "memory database unavailable — deferring memory_daily_run_count creation",
    );
  }
  ensureMemoryDailyRunCountSchema(memoryRaw);
}
