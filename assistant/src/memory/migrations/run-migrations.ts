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
 * Prefix under which forward-step completions are recorded in the shared
 * `memory_checkpoints` ledger. A distinct namespace keeps step bookkeeping from
 * colliding with registry checkpoint keys (`migration_*`, `backfill_*`,
 * `drop_*`) and is deliberately chosen so `validateMigrationState` does not
 * mistake a step record for an unknown registry migration.
 */
const STEP_CHECKPOINT_PREFIX = "step:";

/**
 * Run the ordered list of forward migration steps against the database, each at
 * most once across boots.
 *
 * A step's name is recorded in `memory_checkpoints` after its body completes; on
 * later boots an applied step is skipped instead of re-executed. This turns the
 * unconditional ~200-step re-probe — which floors daemon startup at tens of
 * seconds on a fully-migrated database — into a single bookkeeping read. Steps
 * in {@link RunMigrationStepsOptions.alwaysRun} bypass checkpointing entirely.
 *
 * Step bookkeeping shares the same `memory_checkpoints` ledger that the
 * registry's `withCrashRecovery` uses, under the {@link STEP_CHECKPOINT_PREFIX}
 * namespace, so applied-state for every migration — DDL guard or registry-backed
 * — lives in one place.
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

  // The runner records its own bookkeeping, so it must not depend on an earlier
  // step having created the ledger. createCoreTables also creates this table;
  // `IF NOT EXISTS` makes both paths safe.
  raw.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_checkpoints (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  const applied = new Set(
    (
      raw
        .query(
          `SELECT key FROM memory_checkpoints WHERE key LIKE '${STEP_CHECKPOINT_PREFIX}%'`,
        )
        .all() as Array<{ key: string }>
    ).map((row) => row.key.slice(STEP_CHECKPOINT_PREFIX.length)),
  );
  const markApplied = raw.query(
    `INSERT OR REPLACE INTO memory_checkpoints (key, value, updated_at) VALUES (?, '1', ?)`,
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
        markApplied.run(`${STEP_CHECKPOINT_PREFIX}${name}`, Date.now());
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
 * (guarded by `withCrashRecovery`) clears its own `memory_checkpoints` registry
 * entry when its `down()` runs; the `step:` checkpoint recorded here must be
 * discarded in the same operation, otherwise the runner skips the step on the
 * next upgrade and the rolled-back schema is never restored. Only the `step:`
 * namespace is cleared, leaving registry checkpoints and other ledger entries
 * untouched.
 */
export function clearMigrationStepCheckpoints(database: DrizzleDb): void {
  getSqliteFrom(database).run(
    `DELETE FROM memory_checkpoints WHERE key LIKE '${STEP_CHECKPOINT_PREFIX}%'`,
  );
}
