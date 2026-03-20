import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

/**
 * Create the memory brief state tables: time_contexts and open_loops.
 *
 * Both tables use CREATE TABLE IF NOT EXISTS and CREATE INDEX IF NOT EXISTS,
 * making this migration inherently idempotent — safe to re-run on every startup
 * without a checkpoint guard.
 */
export function migrateMemoryBriefState(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  // -- time_contexts: bounded temporal windows for the brief --
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS time_contexts (
      id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      source TEXT NOT NULL,
      active_from INTEGER NOT NULL,
      active_until INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  raw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_time_contexts_scope_active_until
    ON time_contexts (scope_id, active_until)
  `);

  // -- open_loops: unresolved items the brief should surface --
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS open_loops (
      id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      source TEXT NOT NULL,
      due_at INTEGER,
      surfaced_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  raw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_open_loops_scope_status_due
    ON open_loops (scope_id, status, due_at)
  `);
}
