import { getLogger } from "../util/logger.js";
import { runAsyncSqlite } from "./db-async-query.js";
import { getDb } from "./db-connection.js";
import { runMigrationSteps } from "./migrations/run-migrations.js";
import { validateMigrationState } from "./migrations/validate-migration-state.js";
import { migrationSteps } from "./steps.js";

// ---------------------------------------------------------------------------
// Test DB migration-template cache seam
// ---------------------------------------------------------------------------

/**
 * A test-only accelerator that swaps the full migration chain for a cached,
 * pre-migrated template DB. The implementation lives entirely in the test
 * harness — `src/__tests__/db-template-helpers.ts`, installed via
 * `src/__tests__/db-template-cache.ts` — and is registered on the shared
 * `globalThis.vellumAssistant.dbTemplateCache` slot that this module reads.
 *
 * It is NEVER present in production: nothing outside the test preload installs
 * it, so `getDbTemplateCache()` returns null and `initializeDb()` always runs
 * the real migrations. The slot shape is intentionally duplicated on the test
 * side (see `db-template-cache.ts`) — matching the `dbSingletons` /
 * `featureFlagCache` pattern — so neither side imports the other.
 */
type DbTemplateCache = {
  /**
   * Restore a pre-migrated template into the current workspace and open the
   * connections. Returns true on a cache hit (migrations already applied),
   * false on a miss (the caller must run the full chain, then call `save()`).
   */
  tryRestore(): boolean;
  /** Capture the freshly-migrated DBs as the template for later restores. */
  save(): void;
};

function getDbTemplateCache(): DbTemplateCache | null {
  const g = globalThis as {
    vellumAssistant?: { dbTemplateCache?: DbTemplateCache | null };
  };
  return g.vellumAssistant?.dbTemplateCache ?? null;
}

// ---------------------------------------------------------------------------

/**
 * Off-thread WAL checkpoint, run *before* the first in-process DB open.
 *
 * After an unclean shutdown (SIGKILL from OOM or a failed liveness probe) the
 * WAL is never folded back into the main database — the graceful checkpoint in
 * `shutdown-handlers.ts` is skipped — so it can grow to hundreds of MB across
 * crash-restarts. The first in-process `getDb()` open then runs SQLite WAL
 * recovery synchronously on the main thread (`bun:sqlite` is blocking),
 * stalling the event loop — including `/healthz` — for the full multi-minute
 * scan. That trips the liveness probe and crashloops the pod.
 *
 * Running `wal_checkpoint(TRUNCATE)` through the `sqlite3` subprocess
 * (`runAsyncSqlite`) first performs that recovery + fold + truncate off the
 * event loop, so the subsequent `getDb()` open finds an empty WAL and returns
 * cheaply. We keep `runAsyncSqlite`'s long default timeout deliberately:
 * because the checkpoint runs off the event loop it never blocks `/healthz`,
 * so a large WAL is allowed to flush for as long as it needs rather than
 * timing out and falling back to a blocking open.
 *
 * Best-effort and non-fatal: on any failure (no `sqlite3` binary, lock
 * contention, timeout) we return and let the caller open normally — a blocking
 * recovery, i.e. exactly the prior behavior, never worse. The caller skips
 * this entirely in tests (see `initializeDb`): un-awaited test callers rely on
 * the synchronous prefix of `initializeDb` creating the DB file before the
 * first yield, so no `await` may precede `getDb()` there.
 */
export async function checkpointWalBeforeOpen(): Promise<void> {
  const log = getLogger("db-init");
  try {
    const result = await runAsyncSqlite(
      "PRAGMA wal_checkpoint(TRUNCATE)",
      "db-init:pre-open-wal-checkpoint",
    );
    if (result.ok) {
      log.info(
        { backend: result.backend, elapsedMs: result.elapsedMs },
        "Pre-open WAL checkpoint complete",
      );
    } else {
      log.warn(
        {
          backend: result.backend,
          elapsedMs: result.elapsedMs,
          timedOut: result.timedOut,
          error: result.error,
        },
        "Pre-open WAL checkpoint failed — proceeding to blocking open",
      );
    }
  } catch (err) {
    log.warn(
      { err },
      "Pre-open WAL checkpoint threw — proceeding to blocking open",
    );
  }
}

// ---------------------------------------------------------------------------

export async function initializeDb(): Promise<{ migrationsOk: boolean }> {
  // Under the test harness a migration-template cache is installed (see the
  // DbTemplateCache seam above); a cache hit restores a pre-migrated DB and
  // skips the whole chain. In production the slot is empty, so this is a no-op
  // and migrations always run.
  const templateCache = getDbTemplateCache();
  if (templateCache?.tryRestore()) {
    // A restored template is fully migrated.
    return { migrationsOk: true };
  }

  // Fold any post-crash WAL back into the database off the main event loop
  // before the first open, so a large WAL can't block /healthz through a
  // synchronous in-process WAL recovery and trip the liveness probe.
  //
  // Skipped whenever the template cache is installed — i.e. under the test
  // harness. Those callers may invoke initializeDb() un-awaited and depend on
  // getDb() (below) creating the DB file during the synchronous prefix, before
  // the first yield. Any await ahead of getDb() would defer that and break them.
  if (!templateCache) {
    await checkpointWalBeforeOpen();
  }

  const log = getLogger("db-init");
  const database = getDb();

  // Run each migration step, catching and logging individual failures so one
  // broken migration doesn't prevent independent later ones from succeeding.
  // The runner creates the checkpoint ledger, recovers crashed migrations, then
  // records each step so an already-migrated database skips it on later boots.
  const { applied, failed, skipped } = await runMigrationSteps(
    database,
    migrationSteps,
  );

  log.info(
    {
      applied: applied.length,
      skipped: skipped.length,
      total: migrationSteps.length,
    },
    "DB migration steps complete",
  );

  if (failed.length > 0) {
    log.error(
      { failedMigrations: failed, count: failed.length },
      `DB initialization completed with ${failed.length} failed migration(s)`,
    );
  }

  // A passing post-run validation is part of readiness: validateMigrationState
  // flags schema inconsistencies (e.g. a completed step missing a declared
  // dependsOn checkpoint) that no individual step body surfaces as a failure.
  let validationOk = true;
  try {
    validateMigrationState(database, migrationSteps);
  } catch (err) {
    validationOk = false;
    log.error({ err }, "validateMigrationState failed");
  }

  templateCache?.save();

  // migrationsOk reflects BOTH no failed migration steps AND a passing
  // post-run validation, so an inconsistent schema keeps /readyz at 503.
  return { migrationsOk: failed.length === 0 && validationOk };
}
