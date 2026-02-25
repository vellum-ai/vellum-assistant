import type { DrizzleDb } from '../db-connection.js';

/**
 * Idempotent migration to add a scope_id index on memory_segments.
 * conversation_id is already covered by the composite index
 * idx_memory_segments_conversation_created(conversation_id, created_at DESC)
 * in db-init, so a standalone index is unnecessary.
 */
export function migrateMemorySegmentsIndexes(database: DrizzleDb): void {
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_segments_scope_id ON memory_segments(scope_id)`);
  database.run(/*sql*/ `DROP INDEX IF EXISTS idx_memory_segments_conversation_id`);
}
