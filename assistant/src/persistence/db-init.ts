import { existsSync } from "node:fs";

import { getLogger } from "../util/logger.js";
import { getDbPath } from "../util/platform.js";
import { runAsyncSqlite } from "./db-async-query.js";
import { getDb } from "./db-connection.js";
import { runMigrationSteps } from "./migrations/run-migrations.js";
import { validateMigrationState } from "./migrations/validate-migration-state.js";
import { migrationSteps } from "./steps.js";

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
 * recovery, i.e. exactly the prior behavior, never worse.
 *
 * Returns immediately when there is no `-wal` sidecar: with nothing to fold,
 * spawning the `sqlite3` subprocess would be pure overhead. This is the common
 * case on a clean boot and in tests, whose seeded fixture DB is checkpointed and
 * WAL-free.
 */
export async function checkpointWalBeforeOpen(): Promise<void> {
  if (!existsSync(`${getDbPath()}-wal`)) {
    return;
  }
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
  // Fold any post-crash WAL back into the database off the main event loop
  // before the first open, so a large WAL can't block /healthz through a
  // synchronous in-process WAL recovery and trip the liveness probe. Returns
  // immediately when there is no WAL to fold — the case on a clean boot and for
  // the WAL-free fixture DB test workspaces are seeded with.
  await checkpointWalBeforeOpen();

  const log = getLogger("db-init");
  const database = getDb();

  // Run each migration step, catching and logging individual failures so one
  // broken migration doesn't prevent independent later ones from succeeding.
  // The runner creates the checkpoint ledger, recovers crashed migrations, then
  // records each step so an already-migrated database skips it on later boots.
  const { applied, failed, skipped, deferred } = await runMigrationSteps(
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

  if (deferred.length > 0) {
    log.error(
      { deferredMigrations: deferred, count: deferred.length },
      `DB initialization completed with ${deferred.length} deferred migration(s) whose prerequisites are not applied`,
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

  // migrationsOk requires no failed steps, no deferred steps, and a passing
  // post-run validation, so an inconsistent schema keeps /readyz at 503.
  // Deferrals count because a mis-declared dependsOn would otherwise leave a
  // step silently never running while the daemon reports ready.
  return {
    migrationsOk: failed.length === 0 && deferred.length === 0 && validationOk,
  };
}
