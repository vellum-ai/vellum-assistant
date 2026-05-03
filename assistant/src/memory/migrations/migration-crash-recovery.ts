/**
 * Crash-recovery wrapper for data migration functions.
 *
 * Extracted as a leaf module so individual migration files can import
 * withCrashRecovery without pulling in validate-migration-state.ts, which
 * imports MIGRATION_REGISTRY from registry.ts (which imports every migration
 * file), creating 32 three-node circular dependencies.
 */

import { getLogger } from "../../util/logger.js";
import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

const log = getLogger("memory-db");

/**
 * Run a migration function with checkpoint-based crash recovery.
 *
 * Records a 'started' checkpoint before running, marks it 'failed' on error,
 * and marks it '1' (complete) on success. On next startup, if a 'started' or
 * 'rolling_back' checkpoint exists the migration re-runs; any other value
 * (including 'failed') means it already ran and is skipped.
 *
 * The migrationFn receives the raw SQLite database and should perform its
 * own transaction management internally.
 */
export function withCrashRecovery(
  database: DrizzleDb,
  checkpointKey: string,
  migrationFn: () => void,
): void {
  const raw = getSqliteFrom(database);

  const existing = raw
    .query(`SELECT value FROM memory_checkpoints WHERE key = ?`)
    .get(checkpointKey) as { value: string } | null;
  if (
    existing &&
    existing.value !== "started" &&
    existing.value !== "rolling_back"
  )
    return;

  raw
    .query(
      `INSERT OR REPLACE INTO memory_checkpoints (key, value, updated_at) VALUES (?, 'started', ?)`,
    )
    .run(checkpointKey, Date.now());

  try {
    migrationFn();
  } catch (error) {
    log.error(
      { checkpointKey, error },
      `Memory migration failed: ${checkpointKey} — marking as failed and continuing`,
    );
    raw
      .query(
        `UPDATE memory_checkpoints SET value = 'failed', updated_at = ? WHERE key = ?`,
      )
      .run(Date.now(), checkpointKey);
    return;
  }

  raw
    .query(
      `UPDATE memory_checkpoints SET value = '1', updated_at = ? WHERE key = ?`,
    )
    .run(Date.now(), checkpointKey);
}
