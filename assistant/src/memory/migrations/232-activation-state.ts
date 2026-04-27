import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_activation_state_v1";

/**
 * Create the activation_state table for memory v2 retrieval persistence.
 *
 * One row per conversation captures the latest activation snapshot:
 * - state_json holds a sparse `{slug: activation}` map.
 * - ever_injected_json is an append-only `[{slug, turn}]` list used to keep
 *   injections strictly delta-only across turns.
 * - current_turn tracks the latest turn index the activation reflects.
 *
 * Mirrors the existing `conversation_graph_memory_state` (migration 207)
 * pattern: single-row-per-conversation snapshot rehydrated on resume.
 */
export function migrateActivationState(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);
    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS activation_state (
        conversation_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        state_json TEXT NOT NULL,
        ever_injected_json TEXT NOT NULL DEFAULT '[]',
        current_turn INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )
    `);
  });
}

export function downActivationState(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  raw.exec(/*sql*/ `DROP TABLE IF EXISTS activation_state`);
}
