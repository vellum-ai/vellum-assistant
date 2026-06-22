import { IntegrityError } from "../../util/errors.js";
import { getLogger } from "../../util/logger.js";
import { getDbPath } from "../../util/platform.js";
import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";
import {
  MIGRATION_REGISTRY,
  type MigrationValidationResult,
} from "./registry.js";
import {
  STEP_CHECKPOINT_PREFIX,
} from "./run-migrations.js";

const log = getLogger("memory-db");

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

  // Build a set of completed step names from `step:*` checkpoints with value '1'.
  // The step runner writes these — `migration_*` registry keys are no longer
  // written by migration functions (Phase 2 removed withCrashRecovery).
  const completedStepNames = new Set(
    rows
      .filter(
        (r) =>
          r.key.startsWith(STEP_CHECKPOINT_PREFIX) && r.value === "1",
      )
      .map((r) => r.key.slice(STEP_CHECKPOINT_PREFIX.length)),
  );

  // Map registry entries to their step names to determine which migrations
  // are completed. Multiple registry entries can share the same step name
  // (e.g., 162's two entries both map to migrateGuardianTimestampsEpochMs).
  const completed = new Set<string>();
  for (const entry of MIGRATION_REGISTRY) {
    if (completedStepNames.has(entry.stepName)) {
      completed.add(entry.key);
    }
  }

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

  // Detect step checkpoints that exist in the database but have no
  // corresponding registry entry — these are from a newer version of the daemon.
  const registryStepNames = new Set(MIGRATION_REGISTRY.map((e) => e.stepName));
  const unknownCheckpoints = [...completedStepNames].filter(
    (name) => !registryStepNames.has(name),
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
 *    (`down` is required on `MigrationRegistryEntry` at the type level.)
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
 * `recoverCrashedMigrations` on the next startup. The forward-step checkpoints
 * recorded by the migration runner (the `step:` namespace) for the rolled-back
 * entries are also discarded so a later upgrade re-applies them.
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

  // Read step checkpoints to determine which migrations have been applied.
  let rows: Array<{ key: string; value: string }>;
  try {
    rows = raw
      .query(`SELECT key, value FROM memory_checkpoints`)
      .all() as Array<{ key: string; value: string }>;
  } catch {
    return [];
  }

  // Build a set of completed step names from `step:*` checkpoints with value '1'.
  const completedStepNames = new Set(
    rows
      .filter(
        (r) =>
          r.key.startsWith(STEP_CHECKPOINT_PREFIX) && r.value === "1",
      )
      .map((r) => r.key.slice(STEP_CHECKPOINT_PREFIX.length)),
  );

  // Find registry entries with version > targetVersion whose step is completed.
  // Deduplicate by stepName — multiple registry entries can share the same step
  // (e.g., 162's two entries), and we only need to clear the step checkpoint once.
  const toRollback = MIGRATION_REGISTRY.filter(
    (entry) =>
      entry.version > targetVersion &&
      completedStepNames.has(entry.stepName),
  ).sort((a, b) => b.version - a.version); // reverse version order

  const rolledBack: string[] = [];

  for (const entry of toRollback) {
    const stepKey = `${STEP_CHECKPOINT_PREFIX}${entry.stepName}`;

    // Mark as rolling_back for crash recovery — if the process crashes here,
    // recoverCrashedMigrations will clear this checkpoint on next startup.
    raw
      .query(
        `INSERT OR REPLACE INTO memory_checkpoints (key, value, updated_at) VALUES (?, 'rolling_back', ?)`,
      )
      .run(stepKey, Date.now());

    // Execute the down migration — let it manage its own transaction lifecycle.
    // Many down() functions call BEGIN/COMMIT internally or use PRAGMA statements
    // that are no-ops inside a transaction.
    entry.down(database);

    // Delete the step checkpoint after down() succeeds.
    raw.query(`DELETE FROM memory_checkpoints WHERE key = ?`).run(stepKey);

    log.info(
      { key: entry.key, version: entry.version },
      `Rolled back migration "${entry.key}" (version ${entry.version})`,
    );
    rolledBack.push(entry.key);
  }

  return rolledBack;
}
