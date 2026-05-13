import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_memory_retrospective_state_v1";

/**
 * Create the memory_retrospective_state table.
 *
 * One row per source conversation tracks two independent pointers used by
 * the memory-retrospective background job:
 *
 *   - `last_processed_message_id`: advances ONLY when a retrospective run
 *     completes successfully (wake invoked + returned without error). On any
 *     failure path this stays unchanged so the next run reprocesses the same
 *     messages — the load-bearing correctness invariant.
 *   - `last_run_at`: advances on EVERY job end (success or failure). Drives
 *     the per-conversation cooldown gate in the trigger-check helper so a
 *     failing job can't loop in tight retries across trigger types.
 *
 * The foreign key cascades so the state row dies with its source
 * conversation. Without the cascade, deleted conversations would leak rows.
 */
export function migrateMemoryRetrospectiveState(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS memory_retrospective_state (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        last_processed_message_id TEXT NOT NULL,
        last_run_at INTEGER NOT NULL
      )
    `);
  });
}
