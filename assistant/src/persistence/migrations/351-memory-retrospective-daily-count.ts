import type { Database } from "bun:sqlite";

import type { DrizzleDb } from "../db-connection.js";
import { getMemorySqlite } from "../db-connection.js";

/**
 * Create the `memory_retrospective_daily_count` table on the memory connection
 * (`assistant-memory.db`) — one row per UTC day (`day_key`) holding the
 * assistant-wide count of retrospective enqueue attempts, backing the
 * `memory.retrospective.maxRunsPerAssistantPerDay` runaway backstop. Idempotent
 * (`IF NOT EXISTS`); exported so tests can stand up the memory-side schema
 * directly.
 *
 * The table is not conversation-keyed — it spans every conversation — so it
 * deliberately stays out of `CONVERSATION_KEYED_MEMORY_TABLES`; stale prior-day
 * rows are pruned by the plugin at reservation time rather than by a delete
 * cascade.
 */
export function ensureMemoryRetrospectiveDailyCountSchema(
  memoryRaw: Database,
): void {
  memoryRaw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_retrospective_daily_count (
      day_key TEXT PRIMARY KEY,
      run_count INTEGER NOT NULL
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
export function migrateMemoryRetrospectiveDailyCount(
  _database: DrizzleDb,
): void {
  const memoryRaw = getMemorySqlite();
  if (!memoryRaw) {
    throw new Error(
      "memory database unavailable — deferring memory_retrospective_daily_count creation",
    );
  }
  ensureMemoryRetrospectiveDailyCountSchema(memoryRaw);
}
