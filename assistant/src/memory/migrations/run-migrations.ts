import { getLogger } from "../../util/logger.js";
import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

const log = getLogger("db-init");

/**
 * A single forward migration step, identified for checkpointing and logging by
 * its `.name`. Anonymous steps (empty `.name`) cannot be tracked and always run.
 */
export type MigrationStep = (database: DrizzleDb) => void;

export interface RunMigrationStepsOptions {
  /**
   * Names of steps that must execute on every boot regardless of checkpoint
   * state. Crash recovery and aggregators that dispatch to a registry whose
   * membership grows over time belong here: they are never checkpointed and
   * never skipped, so work added inside them on a later release still runs.
   */
  alwaysRun?: ReadonlySet<string>;
}

export interface MigrationRunResult {
  /** Steps whose body threw. */
  failed: string[];
  /** Steps skipped because a prior run already applied them. */
  skipped: string[];
}

/**
 * Bookkeeping table recording which forward steps have completed. Created on
 * demand so the runner works against a brand-new database and so it is
 * independent of the migration steps themselves (which it gates).
 */
const CHECKPOINT_TABLE = "migration_step_checkpoints";

/**
 * Run the ordered list of forward migration steps against the database, each at
 * most once across boots.
 *
 * A step's name is recorded after its body completes; on later boots an applied
 * step is skipped instead of re-executed. This turns the unconditional
 * ~200-step re-probe — which floors daemon startup at tens of seconds on a
 * fully-migrated database — into a single bookkeeping read. Steps in
 * {@link RunMigrationStepsOptions.alwaysRun} bypass checkpointing entirely.
 *
 * Individual step failures are caught and logged so one broken migration does
 * not prevent independent later ones from succeeding; a failed step is not
 * checkpointed and is retried on the next boot.
 */
export function runMigrationSteps(
  database: DrizzleDb,
  steps: MigrationStep[],
  options: RunMigrationStepsOptions = {},
): MigrationRunResult {
  const { alwaysRun } = options;
  const raw = getSqliteFrom(database);

  raw.run(
    `CREATE TABLE IF NOT EXISTS ${CHECKPOINT_TABLE} (
      step TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )`,
  );

  const applied = new Set(
    (
      raw.query(`SELECT step FROM ${CHECKPOINT_TABLE}`).all() as Array<{
        step: string;
      }>
    ).map((row) => row.step),
  );
  const markApplied = raw.query(
    `INSERT OR REPLACE INTO ${CHECKPOINT_TABLE} (step, applied_at) VALUES (?, ?)`,
  );

  const failed: string[] = [];
  const skipped: string[] = [];

  for (const step of steps) {
    const name = step.name;
    const checkpointable = name !== "" && !(alwaysRun?.has(name) ?? false);

    if (checkpointable && applied.has(name)) {
      skipped.push(name);
      log.debug({ migration: name }, `Skipping applied migration: ${name}`);
      continue;
    }

    try {
      log.debug({ migration: name }, `Starting migration: ${name}`);
      step(database);
      log.debug({ migration: name }, `Migration succeeded: ${name}`);
      if (checkpointable) {
        markApplied.run(name, Date.now());
      }
    } catch (err) {
      failed.push(name);
      log.error({ err, migration: name }, `Migration failed: ${name}`);
    }
  }

  return { failed, skipped };
}

/**
 * Discard every forward-step checkpoint so the next {@link runMigrationSteps}
 * call re-runs and re-records all steps.
 *
 * Migration rollback calls this. A rolled-back step whose body is registry-backed
 * (guarded by `withCrashRecovery`) clears its own `memory_checkpoints` entry when
 * its `down()` runs; the step checkpoint recorded here must be discarded in the
 * same operation, otherwise the runner skips the step on the next upgrade and the
 * rolled-back schema is never restored. Dropping the whole table is safe because
 * the runner recreates it on demand.
 */
export function clearMigrationStepCheckpoints(database: DrizzleDb): void {
  getSqliteFrom(database).run(`DROP TABLE IF EXISTS ${CHECKPOINT_TABLE}`);
}
