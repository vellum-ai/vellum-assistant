import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_create_memory_recall_logs_v1";

/**
 * Create the memory_recall_logs table for the inspector memory tab.
 */
export function migrateCreateMemoryRecallLogs(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS memory_recall_logs (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        message_id TEXT,
        enabled INTEGER NOT NULL,
        degraded INTEGER NOT NULL,
        provider TEXT,
        model TEXT,
        degradation_json TEXT,
        semantic_hits INTEGER NOT NULL,
        merged_count INTEGER NOT NULL,
        selected_count INTEGER NOT NULL,
        tier1_count INTEGER NOT NULL,
        tier2_count INTEGER NOT NULL,
        hybrid_search_latency_ms INTEGER NOT NULL,
        sparse_vector_used INTEGER NOT NULL,
        injected_tokens INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        top_candidates_json TEXT NOT NULL,
        injected_text TEXT,
        reason TEXT,
        created_at INTEGER NOT NULL
      )
    `);

    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_memory_recall_logs_message_id
      ON memory_recall_logs (message_id)
    `);

    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_memory_recall_logs_conversation_id
      ON memory_recall_logs (conversation_id)
    `);
  });
}
