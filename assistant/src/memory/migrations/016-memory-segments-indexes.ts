import type { DrizzleDb } from '../db-connection.js';

/**
 * Idempotent migration to ensure memory_segments has indexes on scope_id and
 * conversation_id for faster lookups.  scope_id was already covered by
 * db-init, but we include both here for completeness.
 */
export function migrateMemorySegmentsIndexes(database: DrizzleDb): void {
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_segments_scope_id ON memory_segments(scope_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_segments_conversation_id ON memory_segments(conversation_id)`);
}
