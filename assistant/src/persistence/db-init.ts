import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";

import { getLogger } from "../util/logger.js";
import { getLogsDbPath } from "../util/logs-db-path.js";
import { getMemoryDbPath } from "../util/memory-db-path.js";
import { ensureDataDir, getDbPath } from "../util/platform.js";
import { getTelemetryDbPath } from "../util/telemetry-db-path.js";
import { _resetDisplayOrderMigrationForTests } from "./conversation-display-order-migration.js";
import { _resetGroupMigrationForTests } from "./conversation-group-migration.js";
import { runAsyncSqlite } from "./db-async-query.js";
import {
  getDb,
  getLogsDb,
  getLogsSqlite,
  getMemoryDb,
  getMemorySqlite,
  getSqlite,
  getTelemetryDb,
  getTelemetrySqlite,
} from "./db-connection.js";
import { runMigrationSteps } from "./migrations/run-migrations.js";
import { validateMigrationState } from "./migrations/validate-migration-state.js";
import { migrationSteps } from "./steps.js";

// ---------------------------------------------------------------------------
// Test DB template — run migrations once, reuse across test files
// ---------------------------------------------------------------------------

/**
 * Whether we are running under a test harness, in which case the migration
 * template cache is active. `bun test` sets `NODE_ENV=test` but does NOT set
 * `BUN_TEST`, so gating on `BUN_TEST` alone silently disables the cache and
 * makes every DB-touching test file re-run the full migration chain. Match the
 * `BUN_TEST === "1" || NODE_ENV === "test"` idiom used throughout the codebase
 * (logger.ts, hook-loader.ts, plugins/registry.ts, …) so the two stay aligned.
 */
function isTestEnvironment(): boolean {
  return process.env.BUN_TEST === "1" || process.env.NODE_ENV === "test";
}

function getTemplateDbPath(): string {
  // Hash this file + all migration files + bootstrap migration so the template
  // auto-invalidates when any migration changes. The migration steps and steps
  // array live in this `persistence/` directory; the bootstrap migration lives
  // under the sibling `memory/` directory.
  const thisFile = new URL(import.meta.url).pathname;
  const persistenceDir = dirname(thisFile);
  const memoryDir = join(persistenceDir, "..", "memory");
  const hash = createHash("md5");
  hash.update(readFileSync(thisFile, "utf-8"));
  const migrationsDir = join(persistenceDir, "migrations");
  for (const name of readdirSync(migrationsDir).sort()) {
    if (name.endsWith(".ts")) {
      hash.update(readFileSync(join(migrationsDir, name), "utf-8"));
    }
  }
  // Include the bootstrap migration (migrateToolCreatedItems) which also runs
  // during initializeDb but lives outside the migrations/ directory.
  const bootstrapFile = join(memoryDir, "graph", "bootstrap.ts");
  if (existsSync(bootstrapFile)) {
    hash.update(readFileSync(bootstrapFile, "utf-8"));
  }
  // Include steps.ts which defines the migration step array (separate from this
  // file) so template invalidates when steps change.
  const stepsFile = join(persistenceDir, "steps.ts");
  if (existsSync(stepsFile)) {
    hash.update(readFileSync(stepsFile, "utf-8"));
  }
  return join(
    tmpdir(),
    `vellum-test-db-template-${hash.digest("hex").slice(0, 12)}.db`,
  );
}

/**
 * Template path for the dedicated `logs` database, kept alongside the main
 * template. All three files must be captured/restored together: the migrated
 * state spans them (llm_request_logs and its indexes live in `logs`), so
 * restoring only the main DB would leave a fresh, empty logs DB with no
 * `llm_request_logs` table.
 */
function getLogsTemplateDbPath(): string {
  return `${getTemplateDbPath()}.logs`;
}

/**
 * Template path for the dedicated `memory` database, kept alongside the main
 * and logs templates. Captured/restored together with them so the restored
 * test DB includes `memory_jobs` (created by migration 298 in this file).
 */
function getMemoryTemplateDbPath(): string {
  return `${getTemplateDbPath()}.memory`;
}

/**
 * Template path for the dedicated `telemetry` database, kept alongside the
 * other templates. Captured/restored together with them so the restored test DB
 * includes `watchdog_events` (created by migration 301 in this file).
 */
function getTelemetryTemplateDbPath(): string {
  return `${getTemplateDbPath()}.telemetry`;
}

/**
 * Replace `destPath` with a fresh copy of `templatePath`.
 *
 * Removes the destination `.db` AND its `-wal`/`-shm` sidecars before copying,
 * for two reasons:
 *   - A test that re-restores mid-run (`resetDbForTesting()` + `initializeDb()`
 *     in a `beforeEach`) leaves `-wal`/`-shm` files behind: bun's `sqlite.close()`
 *     does not checkpoint, so committed frames sit in a stale `-wal`. Copying a
 *     fresh main `.db` over them leaves WAL frames that no longer match, so the
 *     next open reads back either stale rows or `SQLITE_CORRUPT` ("database disk
 *     image is malformed").
 *   - Deleting the main file (rather than overwriting it in place) hands SQLite a
 *     brand-new inode. Overwriting the existing inode while a just-closed
 *     connection's memory-map lingers can make the reopen fail with
 *     `SQLITE_BUSY` ("database is locked").
 */
function restoreDbFile(templatePath: string, destPath: string): void {
  rmSync(destPath, { force: true });
  rmSync(`${destPath}-wal`, { force: true });
  rmSync(`${destPath}-shm`, { force: true });
  copyFileSync(templatePath, destPath);
}

function tryRestoreTemplate(): boolean {
  const templatePath = getTemplateDbPath();
  const logsTemplate = getLogsTemplateDbPath();
  const memoryTemplate = getMemoryTemplateDbPath();
  const telemetryTemplate = getTelemetryTemplateDbPath();
  // Restore only when ALL FOUR templates are present. `saveTemplate()` renames
  // them one at a time, so a parallel test worker can momentarily observe the
  // main template without its logs/memory/telemetry siblings. Restoring then
  // would copy the main DB, leave the dedicated DBs as fresh empty files, and
  // skip migrations — so the next `watchdog_events`/`llm_request_logs`/
  // `memory_jobs` access would fail with a missing-table error. Treating a
  // partial set as "not ready" makes such a worker fall through to a full
  // migrate, which creates every table.
  if (
    !existsSync(templatePath) ||
    !existsSync(logsTemplate) ||
    !existsSync(memoryTemplate) ||
    !existsSync(telemetryTemplate)
  ) {
    return false;
  }
  // getDb() hasn't run yet, so the data directory may not exist.
  ensureDataDir();
  restoreDbFile(templatePath, getDbPath());
  // Restore the dedicated logs/memory/telemetry DBs before their connections
  // open, so the relocated tables are present.
  restoreDbFile(logsTemplate, getLogsDbPath());
  restoreDbFile(memoryTemplate, getMemoryDbPath());
  restoreDbFile(telemetryTemplate, getTelemetryDbPath());
  // Open the pre-migrated copies — the getters set PRAGMAs but skip DDL. Open
  // ALL FOUR connections here, not just main. The full-migration path opens the
  // dedicated logs/memory/telemetry connections as a side effect (migrations
  // 297/298/301 touch them via getMemorySqlite() etc.), so those singletons end
  // up cached against the current workspace. A test that pins the workspace in
  // its top-level body, calls initializeDb(), then swaps VELLUM_WORKSPACE_DIR in
  // a beforeAll hook relies on that caching: the swap is harmless only because
  // the connection is already open. If restore left them unopened, the first
  // post-swap getMemoryDb() would lazily open a fresh, empty DB in the new
  // workspace — missing memory_jobs/llm_request_logs/watchdog_events. Opening
  // them now keeps the restore path behaviourally identical to a full migrate.
  getDb();
  getLogsDb();
  getMemoryDb();
  getTelemetryDb();
  // Reset the process-level guards for the lazy runtime migrations
  // (conversations.group_id; display_order/is_pinned). These run on first
  // conversation access — NOT as part of migrationSteps — so the template does
  // not (and should not) contain their columns: the migrations' own tests need a
  // pristine, pre-migration schema to exercise them. But the guards are
  // module-level booleans that survive a DB swap. Without resetting them, a test
  // that re-restores mid-run (resetDbForTesting() + initializeDb() in a
  // beforeEach) gets a fresh template DB without those columns while the guard
  // still reads "already migrated", so the next conversation query fails with
  // "no such column". Resetting here makes each restored DB re-run the lazy
  // migrations on first access, exactly as an un-cached full migrate would.
  _resetGroupMigrationForTests();
  _resetDisplayOrderMigrationForTests();
  return true;
}

/**
 * Snapshot a live connection to `destPath` via `VACUUM INTO`.
 *
 * We deliberately do NOT `copyFileSync` the live database file. These
 * connections run in WAL mode; a raw file copy captures only the main file and
 * not its `-wal`/`-shm` sidecars, so any page still living in the WAL — or a
 * physical layout left behind by dropped virtual/FTS tables — produces a
 * snapshot that opens but reads back as `SQLITE_CORRUPT` ("database disk image
 * is malformed") on the wrong access pattern. `VACUUM INTO` asks SQLite itself
 * to write a fresh, fully-checkpointed, defragmented database at `destPath`,
 * which is guaranteed consistent regardless of WAL state or table history.
 *
 * `VACUUM INTO` requires the destination not to exist, so a stale temp file
 * from a previously-crashed same-pid run is removed first.
 */
function vacuumInto(sqlite: Database, destPath: string): void {
  rmSync(destPath, { force: true });
  // destPath is a machine-generated tmpdir path (no single quotes), so simple
  // single-quote quoting is safe here.
  sqlite.exec(`VACUUM INTO '${destPath}'`);
}

function saveTemplate(): void {
  try {
    const logsSqlite = getLogsSqlite();
    const memorySqlite = getMemorySqlite();
    const telemetrySqlite = getTelemetrySqlite();
    // Every template must be captured or the set is unusable — tryRestoreTemplate
    // treats a partial set as "not ready". If a dedicated connection failed to
    // open, skip saving entirely so the next file falls through to a full migrate.
    if (!logsSqlite || !memorySqlite || !telemetrySqlite) {
      return;
    }

    const mainTmp = `${getTemplateDbPath()}.${process.pid}`;
    vacuumInto(getSqlite(), mainTmp);
    const logsTmp = `${getLogsTemplateDbPath()}.${process.pid}`;
    vacuumInto(logsSqlite, logsTmp);
    const memoryTmp = `${getMemoryTemplateDbPath()}.${process.pid}`;
    vacuumInto(memorySqlite, memoryTmp);
    const telemetryTmp = `${getTelemetryTemplateDbPath()}.${process.pid}`;
    vacuumInto(telemetrySqlite, telemetryTmp);

    // Atomic renames — safe even with parallel test workers.
    renameSync(mainTmp, getTemplateDbPath());
    renameSync(logsTmp, getLogsTemplateDbPath());
    renameSync(memoryTmp, getMemoryTemplateDbPath());
    renameSync(telemetryTmp, getTelemetryTemplateDbPath());
  } catch {
    // Best effort — next file will just run migrations normally.
  }
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
  if (isTestEnvironment() && tryRestoreTemplate()) {
    // A restored template is fully migrated.
    return { migrationsOk: true };
  }

  // Fold any post-crash WAL back into the database off the main event loop
  // before the first open, so a large WAL can't block /healthz through a
  // synchronous in-process WAL recovery and trip the liveness probe.
  //
  // Guarded so it does not even *await* in tests: `bun test` (NODE_ENV=test)
  // callers invoke initializeDb() un-awaited and depend on getDb() (below)
  // creating the DB file during the synchronous prefix, before the first
  // yield. Any await ahead of getDb() would defer that and break them.
  if (!isTestEnvironment()) {
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

  if (isTestEnvironment()) {
    saveTemplate();
  }

  // migrationsOk reflects BOTH no failed migration steps AND a passing
  // post-run validation, so an inconsistent schema keeps /readyz at 503.
  return { migrationsOk: failed.length === 0 && validationOk };
}
