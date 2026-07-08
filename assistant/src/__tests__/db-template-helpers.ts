/**
 * Test-only DB migration-template cache: run the migration chain once per
 * process, then restore a pre-migrated template into every subsequent test file
 * by file copy instead of re-running all ~260 steps.
 *
 * This is the implementation half of the seam declared in
 * `persistence/db-init.ts`. `initializeDb()` reads a `tryRestore()`/`save()`
 * hook off `globalThis.vellumAssistant.dbTemplateCache`; the test preload
 * installs one (see `db-template-cache.ts`) whose bodies delegate here. Keeping
 * the logic in a test file — not in `db-init.ts` — keeps this test-only
 * machinery out of the production module.
 *
 * Why this file may import from `src/`
 * ------------------------------------
 * The test-machinery isolation rule (see `assistant/AGENTS.md`) forbids
 * `src/`-reaching imports only for infrastructure that runs BEFORE the per-test
 * workspace override is set — the preload, the verifier, and preload-imported
 * helpers. This module is different: it is `require()`d lazily by
 * `db-template-cache.ts` on the FIRST `initializeDb()` call, i.e. at
 * test-execution time, after the workspace override is in place. It therefore
 * imports production modules like any regular `*.test.ts` file. It must never be
 * imported statically by the preload (that would pull the drizzle/schema graph
 * in at preload time — the DB-ghost hazard the rule guards against).
 */

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

import { _resetDisplayOrderMigrationForTests } from "../persistence/conversation-display-order-migration.js";
import { _resetGroupMigrationForTests } from "../persistence/conversation-group-migration.js";
import {
  getDb,
  getLogsDb,
  getLogsSqlite,
  getMemoryDb,
  getMemorySqlite,
  getSqlite,
  getTelemetryDb,
  getTelemetrySqlite,
} from "../persistence/db-connection.js";
import { getLogsDbPath } from "../util/logs-db-path.js";
import { getMemoryDbPath } from "../util/memory-db-path.js";
import { ensureDataDir, getDbPath } from "../util/platform.js";
import { getTelemetryDbPath } from "../util/telemetry-db-path.js";

function getTemplateDbPath(): string {
  // Hash this file + all migration files + bootstrap migration + steps.ts so the
  // template auto-invalidates when any migration (or the build logic here)
  // changes. The migrations and steps array live in the `persistence/`
  // directory; the bootstrap migration lives under the sibling `memory/`
  // directory.
  const thisFile = new URL(import.meta.url).pathname;
  const persistenceDir = join(dirname(thisFile), "..", "persistence");
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
  // Include steps.ts which defines the migration step array so the template
  // invalidates when steps change.
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
 * template. All three must be captured/restored together: the migrated state
 * spans them (llm_request_logs and its indexes live in `logs`), so restoring
 * only the main DB would leave a fresh, empty logs DB with no
 * `llm_request_logs` table.
 */
function getLogsTemplateDbPath(): string {
  return `${getTemplateDbPath()}.logs`;
}

/**
 * Template path for the dedicated `memory` database, kept alongside the main and
 * logs templates. Captured/restored together with them so the restored test DB
 * includes `memory_jobs` (created by migration 298).
 */
function getMemoryTemplateDbPath(): string {
  return `${getTemplateDbPath()}.memory`;
}

/**
 * Template path for the dedicated `telemetry` database, kept alongside the other
 * templates. Captured/restored together with them so the restored test DB
 * includes `watchdog_events` (created by migration 301).
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
 *     in a `beforeEach`) leaves `-wal`/`-shm` files behind: bun's
 *     `sqlite.close()` does not checkpoint, so committed frames sit in a stale
 *     `-wal`. Copying a fresh main `.db` over them leaves WAL frames that no
 *     longer match, so the next open reads back either stale rows or
 *     `SQLITE_CORRUPT` ("database disk image is malformed").
 *   - Deleting the main file (rather than overwriting it in place) hands SQLite
 *     a brand-new inode. Overwriting the existing inode while a just-closed
 *     connection's memory-map lingers can make the reopen fail with
 *     `SQLITE_BUSY` ("database is locked").
 */
function restoreDbFile(templatePath: string, destPath: string): void {
  rmSync(destPath, { force: true });
  rmSync(`${destPath}-wal`, { force: true });
  rmSync(`${destPath}-shm`, { force: true });
  copyFileSync(templatePath, destPath);
}

/**
 * Restore a pre-migrated template into the current workspace. Returns true on a
 * cache hit (the DBs are ready and fully migrated), false on a miss (the caller
 * must run the full migration chain, which then calls {@link saveTemplate}).
 */
export function tryRestoreTemplate(): boolean {
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

/**
 * Capture the just-migrated main + dedicated DBs as the template for later
 * restores. Best-effort: on any failure the next test file simply runs the full
 * migration chain again.
 */
export function saveTemplate(): void {
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
