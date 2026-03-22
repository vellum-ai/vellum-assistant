import { IntegrityError } from "../../util/errors.js";
import { getLogger } from "../../util/logger.js";
import { getDbPath } from "../../util/platform.js";
import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";
import {
  MIGRATION_REGISTRY,
  type MigrationValidationResult,
} from "./registry.js";

const log = getLogger("memory-db");

/**
 * Recover from crashed migrations before the migration runner executes.
 *
 * Scans memory_checkpoints for entries with value 'started' — these represent
 * migrations that began but never completed (e.g., due to a process crash).
 * Deletes the stalled checkpoint so the migration can re-run from scratch on
 * this startup. Each migration's own idempotency guards (DDL IF NOT EXISTS,
 * transactional rollback) ensure re-running is safe.
 *
 * Call this BEFORE running migrations so that stalled checkpoints don't block
 * re-execution.
 */
export function recoverCrashedMigrations(database: DrizzleDb): string[] {
  const raw = getSqliteFrom(database);

  let rows: Array<{ key: string; value: string }>;
  try {
    rows = raw
      .query(`SELECT key, value FROM memory_checkpoints`)
      .all() as Array<{ key: string; value: string }>;
  } catch {
    return [];
  }

  const crashed = rows
    .filter((r) => r.value === "started" || r.value === "rolling_back")
    .map((r) => r.key);
  if (crashed.length === 0) return [];

  log.error(
    { crashed },
    [
      "╔══════════════════════════════════════════════════════════════╗",
      "║  CRASHED MIGRATIONS DETECTED — AUTO-RECOVERING             ║",
      "╚══════════════════════════════════════════════════════════════╝",
      "",
      `The following migrations started but never completed: ${crashed.join(", ")}`,
      "",
      "Clearing stalled checkpoints so they can be retried on this startup.",
      "If retries continue to fail, manually inspect the database:",
      `  sqlite3 ${getDbPath()} "SELECT * FROM memory_checkpoints"`,
    ].join("\n"),
  );

  for (const key of crashed) {
    raw.query(`DELETE FROM memory_checkpoints WHERE key = ?`).run(key);
    log.info(
      { key },
      `Cleared stalled checkpoint "${key}" — migration will re-run`,
    );
  }

  return crashed;
}

/**
 * Wrap a migration function with crash-recovery bookkeeping.
 *
 * Writes a 'started' checkpoint before executing the migration body, then
 * overwrites it with the completion value on success. If the process crashes
 * between the start marker and completion, recoverCrashedMigrations (which
 * runs before all migrations) will detect and clear it on the next startup.
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

  migrationFn();

  raw
    .query(
      `UPDATE memory_checkpoints SET value = '1', updated_at = ? WHERE key = ?`,
    )
    .run(Date.now(), checkpointKey);
}

/**
 * Validate the applied migration state against the registry at startup.
 *
 * Logs a prominent error when a migration started but never completed (crash
 * detected) — startup continues so the migration can be retried.
 *
 * Throws an IntegrityError when a migration was applied but a declared
 * prerequisite is missing from the checkpoints table (dependency ordering
 * violation). This blocks daemon startup to prevent running with an
 * inconsistent database schema.
 *
 * Call this AFTER all DDL and migration functions have run so that the final
 * state is inspected.
 */
export function validateMigrationState(
  database: DrizzleDb,
): MigrationValidationResult {
  const raw = getSqliteFrom(database);

  let rows: Array<{ key: string; value: string }>;
  try {
    rows = raw
      .query(`SELECT key, value FROM memory_checkpoints`)
      .all() as Array<{ key: string; value: string }>;
  } catch {
    // memory_checkpoints may not exist on a very old database; skip.
    return { crashed: [], dependencyViolations: [], unknownCheckpoints: [] };
  }

  // Any remaining 'started' or 'rolling_back' checkpoints after recovery +
  // migration execution indicate a migration that was retried but failed again.
  const crashed = rows
    .filter((r) => r.value === "started" || r.value === "rolling_back")
    .map((r) => r.key);
  if (crashed.length > 0) {
    log.error(
      { crashed },
      [
        "╔══════════════════════════════════════════════════════════════╗",
        "║  MIGRATIONS STILL INCOMPLETE AFTER RETRY                   ║",
        "╚══════════════════════════════════════════════════════════════╝",
        "",
        `The following migrations were retried but still did not complete: ${crashed.join(", ")}`,
        "",
        "Manual intervention is required. Inspect the database and resolve:",
        `  sqlite3 ${getDbPath()} "DELETE FROM memory_checkpoints WHERE key = '<migration_key>'"`,
        "Then restart the daemon.",
      ].join("\n"),
    );
  }

  // Only rows whose value is NOT 'started' or 'rolling_back' represent truly
  // completed migrations. In-progress/crashed checkpoints must not count as
  // applied dependencies — the migration never finished, so its postconditions
  // are unmet.
  const completed = new Set(
    rows
      .filter((r) => r.value !== "started" && r.value !== "rolling_back")
      .map((r) => r.key),
  );

  const dependencyViolations: Array<{
    migration: string;
    missingDependency: string;
  }> = [];

  // Validate dependency ordering.
  for (const entry of MIGRATION_REGISTRY) {
    if (!entry.dependsOn || entry.dependsOn.length === 0) continue;
    // Only check entries that have been completed — unapplied or in-progress
    // migrations have not had a chance to violate their prerequisites yet.
    if (!completed.has(entry.key)) continue;

    for (const dep of entry.dependsOn) {
      if (!completed.has(dep)) {
        dependencyViolations.push({
          migration: entry.key,
          missingDependency: dep,
        });
      }
    }
  }

  if (dependencyViolations.length > 0) {
    const details = dependencyViolations
      .map(
        (v) =>
          `  - "${v.migration}" requires "${v.missingDependency}" but it has no checkpoint`,
      )
      .join("\n");
    throw new IntegrityError(
      `Migration dependency violations detected — database schema may be inconsistent:\n${details}\n` +
        "The daemon cannot start safely. Inspect the database and re-run missing migrations.",
    );
  }

  // Detect checkpoints that exist in the database but have no corresponding
  // registry entry — these are from a newer version of the daemon.
  //
  // The memory_checkpoints table is a general-purpose key-value store also
  // used by non-migration subsystems (e.g., "identity:intro:text",
  // "conversation_starters:item_count_at_last_gen"). Filter to only keys
  // that follow migration naming conventions before comparing against the
  // registry to avoid false-positive warnings.
  const registryKeys = new Set(MIGRATION_REGISTRY.map((e) => e.key));
  const isMigrationKey = (k: string): boolean =>
    k.startsWith("migration_") ||
    k.startsWith("backfill_") ||
    k.startsWith("drop_");
  const unknownCheckpoints = [...completed].filter(
    (k) => isMigrationKey(k) && !registryKeys.has(k),
  );

  if (unknownCheckpoints.length > 0) {
    log.warn(
      { unknownCheckpoints },
      `Database contains ${unknownCheckpoints.length} migration checkpoint(s) from a newer version. Data may be incompatible.`,
    );
  }

  return { crashed, dependencyViolations, unknownCheckpoints };
}

/**
 * Roll back all completed memory (database) migrations with version > targetVersion.
 *
 * Iterates eligible migrations in reverse version order. For each:
 * 1. Marks the checkpoint as `"rolling_back"` for crash recovery.
 * 2. Calls `entry.down(database)` — each down() manages its own transactions.
 *    (`down` is required on `MemoryMigrationEntry` at the type level.)
 * 3. Deletes the checkpoint from `memory_checkpoints`.
 *
 * **Usage**: Pass the target version number you want to roll back *to*. All
 * migrations with a higher version number that have been applied will be
 * reversed. For example, `rollbackMemoryMigration(db, 5)` rolls back all
 * applied migrations with version > 5.
 *
 * **Checkpoint state**: Each rolled-back migration's checkpoint is deleted
 * from `memory_checkpoints`. If the process crashes mid-rollback, the
 * `"rolling_back"` marker is detected and cleared by
 * `recoverCrashedMigrations` on the next startup.
 *
 * **Warning — data loss**: Some down() migrations may not fully restore the
 * original state (e.g., DROP TABLE migrations recreate the table but cannot
 * recover the original data). Review each migration's down() implementation
 * before calling this function programmatically.
 *
 * **Important**: Stop the assistant before running rollbacks. Rolling back
 * migrations while the assistant is running may cause schema mismatches,
 * query failures, or data corruption.
 *
 * @param database  The Drizzle database instance.
 * @param targetVersion  Roll back to this version (exclusive — all migrations
 *   with version > targetVersion are reversed).
 * @returns The list of rolled-back migration keys.
 */
export function rollbackMemoryMigration(
  database: DrizzleDb,
  targetVersion: number,
): string[] {
  const raw = getSqliteFrom(database);

  // Read completed checkpoints to determine which migrations have been applied.
  let rows: Array<{ key: string; value: string }>;
  try {
    rows = raw
      .query(`SELECT key, value FROM memory_checkpoints`)
      .all() as Array<{ key: string; value: string }>;
  } catch {
    return [];
  }

  const completedKeys = new Set(
    rows
      .filter((r) => r.value !== "started" && r.value !== "rolling_back")
      .map((r) => r.key),
  );

  // Find registry entries with version > targetVersion that have completed checkpoints.
  const toRollback = MIGRATION_REGISTRY.filter(
    (entry) => entry.version > targetVersion && completedKeys.has(entry.key),
  ).sort((a, b) => b.version - a.version); // reverse version order

  const rolledBack: string[] = [];

  for (const entry of toRollback) {
    // Mark as rolling_back for crash recovery — if the process crashes here,
    // recoverCrashedMigrations will clear this checkpoint on next startup.
    raw
      .query(
        `UPDATE memory_checkpoints SET value = 'rolling_back', updated_at = ? WHERE key = ?`,
      )
      .run(Date.now(), entry.key);

    // Execute the down migration — let it manage its own transaction lifecycle.
    // Many down() functions call BEGIN/COMMIT internally or use PRAGMA statements
    // that are no-ops inside a transaction.
    entry.down(database);

    // Delete the checkpoint after down() succeeds — outside any transaction
    // so it's not affected by down()'s internal transaction management.
    raw.query(`DELETE FROM memory_checkpoints WHERE key = ?`).run(entry.key);

    log.info(
      { key: entry.key, version: entry.version },
      `Rolled back migration "${entry.key}" (version ${entry.version})`,
    );
    rolledBack.push(entry.key);
  }

  return rolledBack;
}
