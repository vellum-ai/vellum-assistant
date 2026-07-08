import { IntegrityError } from "../../util/errors.js";
import { getLogger } from "../../util/logger.js";
import { getDbPath } from "../../util/platform.js";
import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";
import {
  getStepName,
  type MigrationStep,
  normalizeStep,
  STEP_CHECKPOINT_PREFIX,
} from "./run-migrations.js";

// Share the DB-init logger namespace so the whole startup DB-migration
// sequence (run steps -> summary -> post-run validation) reports under a
// single `[db-init]` tag instead of being split across modules.
const log = getLogger("db-init");

export interface MigrationValidationResult {
  /** Keys of migrations whose checkpoint has value 'started' — started but never completed. */
  crashed: string[];
  /** Pairs where a completed migration's declared prerequisite is missing from checkpoints. */
  dependencyViolations: Array<{ migration: string; missingDependency: string }>;
  /** Checkpoint keys present in the database but absent from the known step names — likely from a newer version. */
  unknownCheckpoints: string[];
}

/**
 * Validate the applied migration state against the known step list at startup.
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
 *
 * @param database  The Drizzle database instance.
 * @param steps     The full ordered migration step array (same one passed to
 *   `runMigrationSteps`). Used to determine known step names for unknown-checkpoint
 *   detection and to check `dependsOn` declarations.
 */
export function validateMigrationState(
  database: DrizzleDb,
  steps: MigrationStep[],
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
  const completedStepNames = new Set(
    rows
      .filter(
        (r) => r.key.startsWith(STEP_CHECKPOINT_PREFIX) && r.value === "1",
      )
      .map((r) => r.key.slice(STEP_CHECKPOINT_PREFIX.length)),
  );

  // Check dependency ordering for object-form steps that declare dependsOn.
  // A step is "completed" if its name appears in the completedStepNames set.
  const dependencyViolations: Array<{
    migration: string;
    missingDependency: string;
  }> = [];

  for (const step of steps) {
    const obj = normalizeStep(step);
    if (!obj.dependsOn || obj.dependsOn.length === 0) continue;
    // Only check steps that have been completed — unapplied or in-progress
    // migrations have not had a chance to violate their prerequisites yet.
    if (!completedStepNames.has(obj.name)) continue;

    for (const dep of obj.dependsOn) {
      if (!completedStepNames.has(dep)) {
        dependencyViolations.push({
          migration: obj.name,
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
  // corresponding entry in the known step list — these are from a newer
  // version of the daemon.
  const knownStepNames = new Set(steps.map((s) => getStepName(s)));
  const unknownCheckpoints = [...completedStepNames].filter(
    (name) => !knownStepNames.has(name),
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
 * Iterates eligible migration steps in reverse version order. For each
 * rollback entry on a completed step:
 * 1. Marks the step checkpoint as `"rolling_back"` for crash recovery.
 * 2. Calls `entry.down(database)` — each down() manages its own transactions.
 * 3. Deletes the step checkpoint from `memory_checkpoints`.
 *
 * A single step may carry multiple rollback entries (e.g. migration 162 has
 * two). All entries with version > target are rolled back in reverse version
 * order. The step checkpoint is only deleted after the last rollback entry
 * for that step completes.
 *
 * **Usage**: Pass the target version number you want to roll back *to*. All
 * rollback entries with a higher version number on completed steps will be
 * reversed. For example, `rollbackMemoryMigration(db, 5, steps)` rolls back
 * all rollback entries with version > 5.
 *
 * **Checkpoint state**: Each rolled-back step's `step:*` checkpoint is deleted
 * from `memory_checkpoints` after its down() functions succeed. If the process
 * crashes mid-rollback, the `"rolling_back"` marker is detected and cleared by
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
 * @param targetVersion  Roll back to this version (exclusive — all rollback
 *   entries with version > targetVersion are reversed).
 * @param steps     The full ordered migration step array.
 * @returns The list of rolled-back step names.
 */
export function rollbackMemoryMigration(
  database: DrizzleDb,
  targetVersion: number,
  steps: MigrationStep[],
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
        (r) => r.key.startsWith(STEP_CHECKPOINT_PREFIX) && r.value === "1",
      )
      .map((r) => r.key.slice(STEP_CHECKPOINT_PREFIX.length)),
  );

  // Collect all rollback entries with version > targetVersion on completed steps.
  // Each entry references its parent step name so we can clear the checkpoint
  // after all rollback entries for that step have been executed.
  interface RollbackItem {
    stepName: string;
    version: number;
    description: string;
    down: (db: DrizzleDb) => void;
  }

  const toRollback: RollbackItem[] = [];
  for (const step of steps) {
    const obj = normalizeStep(step);
    if (!obj.rollback) continue;
    if (!completedStepNames.has(obj.name)) continue;

    for (const entry of obj.rollback) {
      if (entry.version > targetVersion) {
        toRollback.push({
          stepName: obj.name,
          version: entry.version,
          description: entry.description,
          down: entry.down,
        });
      }
    }
  }

  // Sort in reverse version order — children (higher version) before parents.
  toRollback.sort((a, b) => b.version - a.version);

  // Group by stepName so we only delete the checkpoint after all rollback
  // entries for that step have been executed.
  const stepNamesToRollback = new Set(toRollback.map((r) => r.stepName));
  const rolledBack: string[] = [];

  for (const item of toRollback) {
    const stepKey = `${STEP_CHECKPOINT_PREFIX}${item.stepName}`;

    // Mark as rolling_back for crash recovery.
    raw
      .query(
        `INSERT OR REPLACE INTO memory_checkpoints (key, value, updated_at) VALUES (?, 'rolling_back', ?)`,
      )
      .run(stepKey, Date.now());

    // Execute the down migration.
    item.down(database);

    log.info(
      {
        step: item.stepName,
        version: item.version,
        description: item.description,
      },
      `Rolled back migration "${item.stepName}" (version ${item.version})`,
    );
  }

  // After all down() calls succeed, delete checkpoints for the rolled-back steps.
  for (const stepName of stepNamesToRollback) {
    const stepKey = `${STEP_CHECKPOINT_PREFIX}${stepName}`;
    raw.query(`DELETE FROM memory_checkpoints WHERE key = ?`).run(stepKey);
    rolledBack.push(stepName);
  }

  return rolledBack;
}
