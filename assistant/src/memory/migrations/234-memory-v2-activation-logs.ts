import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_memory_v2_activation_logs_v1";

/**
 * Create the memory_v2_activation_logs table for per-turn v2 activation
 * telemetry.
 *
 * Each row captures one activation pass keyed by (conversation, turn, mode):
 * - mode is "context-load" (initial conversation hydration) or "per-turn"
 *   (each subsequent agent turn).
 * - concepts_json / skills_json hold the structured activation outputs.
 * - config_json captures the resolved config snapshot used for the pass so
 *   the inspector can reproduce activation conditions.
 *
 * Indexes mirror the access patterns used by the inspector tab: lookup by
 * message_id, by conversation_id, and ordering by created_at.
 */
export function migrateMemoryV2ActivationLogs(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);
    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS memory_v2_activation_logs (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        message_id TEXT,
        turn INTEGER NOT NULL,
        mode TEXT NOT NULL,
        concepts_json TEXT NOT NULL,
        skills_json TEXT NOT NULL,
        config_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_memory_v2_activation_logs_message_id
        ON memory_v2_activation_logs (message_id)
    `);
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_memory_v2_activation_logs_conversation_id
        ON memory_v2_activation_logs (conversation_id)
    `);
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_memory_v2_activation_logs_created_at
        ON memory_v2_activation_logs (created_at)
    `);
  });
}

export function downMemoryV2ActivationLogs(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  raw.exec(/*sql*/ `DROP TABLE IF EXISTS memory_v2_activation_logs`);
}
