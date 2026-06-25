import { getLogger } from "../../util/logger.js";
import { getDbPath } from "../../util/platform.js";
import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

const log = getLogger("db-init");

/**
 * Rollback metadata for a migration step that can be reversed.
 *
 * A single step may carry multiple rollback entries (e.g. migration 162 has
 * two: one for the timestamp conversion and one for the table rebuild). Each
 * entry has its own monotonic version number for rollback ordering and its
 * own `down()` function.
 */
export interface RollbackEntry {
  /** Monotonic version used for rollback ordering. */
  version: number;
  /** Human-readable description for diagnostics. */
  description: string;
  /** Reverse the migration. Must be idempotent — safe to re-run. */
  down: (database: DrizzleDb) => void;
}

/**
 * Object form of a migration step, carrying optional rollback metadata and
 * dependency declarations inline — no separate registry needed.
 */
export interface MigrationStepObject {
  /** Step name — used for `step:*` checkpoint key, logging, and skip logic. */
  name: string;
  /** Forward migration body. */
  run: (database: DrizzleDb) => void | Promise<void>;
  /** Step names that must complete before this step runs. */
  dependsOn?: string[];
  /** Rollback entries — present if this step has down() function(s). */
  rollback?: RollbackEntry[];
}

/**
 * A single forward migration step, identified for checkpointing and logging by
 * its `.name`. Anonymous steps (empty `.name`) cannot be tracked and always run.
 *
 * Bare function steps are identified by `Function.name`. Object-form steps
 * carry an explicit `name` plus optional `rollback` and `dependsOn` metadata.
 *
 * A step may be synchronous or return a promise. The runner awaits an async
 * step to completion before checkpointing it and moving on, so ordering is
 * preserved exactly as for sync steps: step N+1 never starts — and is never
 * skipped via checkpoint — until step N has fully finished. This lets a step
 * that drains a large backfill in `await`ed batches run without blocking the
 * thread between batches while still guaranteeing later migrations observe its
 * completed result.
 */
export type MigrationStep =
  | MigrationStepObject
  | ((database: DrizzleDb) => void | Promise<void>);

/**
 * Normalize a {@link MigrationStep} (which may be a bare function or an object)
 * into its object form so callers don't need to type-narrow.
 */
export function normalizeStep(step: MigrationStep): MigrationStepObject {
  if (typeof step === "function") {
    return { name: step.name, run: step };
  }
  return step;
}

/**
 * Extract the step name from either form of {@link MigrationStep}.
 */
export function getStepName(step: MigrationStep): string {
  return typeof step === "function" ? step.name : step.name;
}

/**
 * Get the maximum rollback version across all steps that carry rollback
 * metadata. Returns 0 if no steps have rollback entries.
 */
export function getMaxRollbackVersion(steps: MigrationStep[]): number {
  let max = 0;
  for (const step of steps) {
    if (typeof step === "function") continue;
    if (!step.rollback) continue;
    for (const entry of step.rollback) {
      if (entry.version > max) max = entry.version;
    }
  }
  return max;
}

/**
 * Collect all step names that appear in the steps array (both bare-function
 * and object-form). Used by {@link validateMigrationState} to detect
 * checkpoints from a newer daemon version.
 */
export function getKnownStepNames(steps: MigrationStep[]): Set<string> {
  const names = new Set<string>();
  for (const step of steps) {
    names.add(getStepName(step));
  }
  return names;
}

export interface MigrationRunResult {
  /** Steps that ran and completed successfully this boot. */
  applied: string[];
  /** Steps whose body threw. */
  failed: string[];
  /** Steps skipped because a prior run already applied them. */
  skipped: string[];
}

/**
 * Prefix under which forward-step completions are recorded in the shared
 * `memory_checkpoints` ledger. A distinct namespace keeps step bookkeeping from
 * colliding with legacy checkpoint keys (`migration_*`, `backfill_*`,
 * `drop_*`) left by older migration functions.
 */
export const STEP_CHECKPOINT_PREFIX = "step:";

/**
 * Create the migration bookkeeping table if it is missing.
 *
 * The runner records its own checkpoints, so it must not depend on an earlier
 * step having created the ledger. This is the single place `memory_checkpoints`
 * is created; `IF NOT EXISTS` makes it a no-op on an already-migrated database.
 */
function ensureCheckpointsTable(raw: ReturnType<typeof getSqliteFrom>): void {
  raw.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_checkpoints (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

/**
 * Recover from crashed migrations before the migration runner executes its steps.
 *
 * Scans memory_checkpoints for entries with value 'started' or 'rolling_back' —
 * these represent migrations that began but never completed (e.g., due to a
 * process crash). Deletes the stalled checkpoint so the migration can re-run
 * from scratch on this startup. Each migration's own idempotency guards (DDL
 * IF NOT EXISTS, transactional rollback) ensure re-running is safe.
 *
 * Runs on every boot — it must observe the state left by *this* boot's prior
 * crash — so it is invoked directly by {@link runMigrationSteps} before the
 * checkpointed step loop rather than being a checkpointed step itself.
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
 * Run the ordered list of forward migration steps against the database, each at
 * most once across boots.
 *
 * A step's name is recorded in `memory_checkpoints` after its body completes —
 * for an async step, after its returned promise resolves; on
 * later boots an applied step is skipped instead of re-executed. This turns the
 * unconditional ~200-step re-probe — which floors daemon startup at tens of
 * seconds on a fully-migrated database — into a single bookkeeping read.
 *
 * Step bookkeeping lives in the `memory_checkpoints` ledger under the
 * {@link STEP_CHECKPOINT_PREFIX} namespace, so applied-state for every
 * migration lives in one place.
 *
 * Before the step loop runs, the ledger is created if missing and
 * {@link recoverCrashedMigrations} clears any stalled checkpoints left by a
 * prior crash, so a migration interrupted mid-flight re-runs this boot.
 *
 * Individual step failures are caught and logged so one broken migration does
 * not prevent independent later ones from succeeding; a failed step is not
 * checkpointed and is retried on the next boot.
 */
export async function runMigrationSteps(
  database: DrizzleDb,
  steps: MigrationStep[],
): Promise<MigrationRunResult> {
  const raw = getSqliteFrom(database);

  ensureCheckpointsTable(raw);
  recoverCrashedMigrations(database);

  const applied = new Set(
    (
      raw
        .query(
          `SELECT key FROM memory_checkpoints WHERE key LIKE '${STEP_CHECKPOINT_PREFIX}%' AND value = '1'`,
        )
        .all() as Array<{ key: string }>
    ).map((row) => row.key.slice(STEP_CHECKPOINT_PREFIX.length)),
  );
  const markStarted = raw.query(
    `INSERT OR REPLACE INTO memory_checkpoints (key, value, updated_at) VALUES (?, 'started', ?)`,
  );
  const markApplied = raw.query(
    `INSERT OR REPLACE INTO memory_checkpoints (key, value, updated_at) VALUES (?, '1', ?)`,
  );

  const failed: string[] = [];
  const skipped: string[] = [];
  const ran: string[] = [];

  const totalSteps = steps.length;
  for (const [index, step] of steps.entries()) {
    const obj = normalizeStep(step);
    const name = obj.name;
    const checkpointable = name !== "";
    // 1-based position of this step in the ordered migration sequence.
    const stepNumber = index + 1;

    if (checkpointable && applied.has(name)) {
      skipped.push(name);
      log.debug({ migration: name }, `Skipping applied migration: ${name}`);
      continue;
    }

    try {
      if (checkpointable) {
        markStarted.run(`${STEP_CHECKPOINT_PREFIX}${name}`, Date.now());
      }
      log.info(
        { migration: name, step: stepNumber, totalSteps },
        "Migration started",
      );
      const result = obj.run(database);
      if (result instanceof Promise) {
        await result;
      }
      log.info(
        { migration: name, step: stepNumber, totalSteps },
        "Migration succeeded",
      );
      if (checkpointable) {
        markApplied.run(`${STEP_CHECKPOINT_PREFIX}${name}`, Date.now());
        ran.push(name);
      }
    } catch (err) {
      // Leave the 'started' marker in place (if one was written) —
      // recoverCrashedMigrations will detect it on the next boot, log
      // a warning, and clear it so the step re-runs.
      failed.push(name);
      log.error(
        { err, migration: name, step: stepNumber, totalSteps },
        "Migration failed",
      );
    }
  }

  return { applied: ran, failed, skipped };
}

/**
 * Discard every forward-step checkpoint so the next {@link runMigrationSteps}
 * call re-runs and re-records all steps.
 *
 * Migration rollback calls this. A rolled-back step's `step:` checkpoint
 * must be discarded, otherwise the runner skips the step on the next
 * upgrade and the rolled-back schema is never restored. Only the `step:`
 * namespace is cleared, leaving other ledger entries untouched.
 */
export function clearMigrationStepCheckpoints(database: DrizzleDb): void {
  getSqliteFrom(database).run(
    `DELETE FROM memory_checkpoints WHERE key LIKE '${STEP_CHECKPOINT_PREFIX}%'`,
  );
}
