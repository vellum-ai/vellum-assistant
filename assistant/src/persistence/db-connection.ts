import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { Database } from "bun:sqlite";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getLogsDbPath } from "../util/logs-db-path.js";
import { getMemoryDbPath } from "../util/memory-db-path.js";
import { ensureDataDir, getDbPath } from "../util/platform.js";
import { getTelemetryDbPath } from "../util/telemetry-db-path.js";
import { clearStoredDb, getStoredDb, setStoredDb } from "./db-singleton.js";
import * as schema from "./schema/index.js";
import { wrapSqliteForSlowQueryLogging } from "./slow-query-log.js";

export type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

function canonicalizePathThroughExistingParent(path: string): string {
  const resolvedPath = resolve(path);
  const pendingSegments: string[] = [];
  let currentPath = resolvedPath;

  while (true) {
    try {
      return resolve(realpathSync(currentPath), ...pendingSegments.reverse());
    } catch {
      const parentPath = dirname(currentPath);
      if (parentPath === currentPath) {
        return resolvedPath;
      }
      pendingSegments.push(basename(currentPath));
      currentPath = parentPath;
    }
  }
}

/**
 * Guard against opening a real workspace database during tests. Shared by
 * every connection opener (main, logs, memory) so a misconfigured test run
 * cannot write to the real `~/.vellum/workspace` files through any of them.
 */
export function assertTestDbIsIsolated(): void {
  if (
    process.env.NODE_ENV !== "test" ||
    process.env.VELLUM_ALLOW_REAL_WORKSPACE_IN_TESTS === "1"
  ) {
    return;
  }

  const workspaceDir = process.env.VELLUM_WORKSPACE_DIR?.trim();
  if (!workspaceDir) {
    throw new Error(
      [
        "Refusing to open the assistant DB during tests without VELLUM_WORKSPACE_DIR.",
        "Run assistant tests from the assistant package so the test preload can isolate state:",
        "  cd assistant && bun test src/path/to/file.test.ts",
      ].join("\n"),
    );
  }

  const resolvedWorkspaceDir =
    canonicalizePathThroughExistingParent(workspaceDir);
  const realWorkspaceDir = canonicalizePathThroughExistingParent(
    process.env.VELLUM_TEST_REAL_WORKSPACE_DIR?.trim() ||
      join(homedir(), ".vellum", "workspace"),
  );
  if (
    resolvedWorkspaceDir === realWorkspaceDir ||
    resolvedWorkspaceDir.startsWith(realWorkspaceDir + sep)
  ) {
    throw new Error(
      [
        "Refusing to open the real assistant workspace DB during tests.",
        `VELLUM_WORKSPACE_DIR resolved to ${resolvedWorkspaceDir}.`,
        "Use a temp workspace for tests instead.",
      ].join("\n"),
    );
  }
}

/**
 * How long a SQLite connection waits to acquire a lock held by another
 * writer before giving up with `SQLITE_BUSY`. Every connection that touches
 * an assistant database — the main/dedicated daemon connections here and the
 * out-of-process / transient connections in `db-async-query.ts` — must set
 * the same value, so a writer that grabs the lock can finish without a
 * concurrent writer failing immediately instead of waiting its turn.
 */
export const SQLITE_BUSY_TIMEOUT_MS = 5000;

/**
 * Apply the connection-wide PRAGMAs every assistant SQLite connection runs
 * with. These are per-connection settings, so the dedicated logs/memory
 * connections set them independently of the main connection.
 */
function applyConnectionPragmas(sqlite: Database): void {
  sqlite.exec("PRAGMA journal_mode=WAL");
  // NORMAL (not FULL) under WAL: the WAL+checkpoint protocol still guarantees
  // database integrity across crashes; only the durability of the last few
  // committed transactions is at risk on an OS crash/power loss. Dropping the
  // per-commit fsync is a large latency win on write-heavy paths.
  sqlite.exec("PRAGMA synchronous=NORMAL");
  sqlite.exec(`PRAGMA busy_timeout=${SQLITE_BUSY_TIMEOUT_MS}`);
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec("PRAGMA cache_size=-256000");
  sqlite.exec("PRAGMA temp_store=MEMORY");
  // Checkpointing alone never shrinks the WAL file — a fully-backfilled WAL
  // is reused from offset 0 at its high-water size, so a single write burst
  // otherwise leaves a permanently huge file (disk cost, plus a long recovery
  // scan on the first open after a hard crash). With a size limit, any WAL
  // reset also truncates the file to at most this many bytes. 64 MB
  // comfortably exceeds the WAL's steady-state hover (the ~4 MB autocheckpoint
  // threshold), so normal writes never pay file re-extension.
  sqlite.exec("PRAGMA journal_size_limit=67108864");
}

export function getDb(): DrizzleDb {
  const existing = getStoredDb<DrizzleDb>("main");
  if (existing) {
    return existing;
  }

  assertTestDbIsIsolated();
  ensureDataDir();
  const sqlite = new Database(getDbPath());
  applyConnectionPragmas(sqlite);
  wrapSqliteForSlowQueryLogging(sqlite);
  const db = drizzle(sqlite, { schema });
  setStoredDb("main", db, () => sqlite.close());
  return db;
}

/**
 * A dedicated read-only connection to the main database, opened lazily in
 * its own singleton slot — never shared with `getDb()`'s read-write
 * connection. For worker processes (the resource monitor) that observe the
 * daemon's main DB: WAL permits cross-process readers, the daemon stays the
 * main DB's sole writer, and a read-only connection makes an accidental
 * worker-side write fail loudly instead of contending for the write lock.
 *
 * Read-only connections skip the standard PRAGMAs: journal_mode /
 * journal_size_limit write to the database file, and synchronous /
 * foreign_keys only affect writes. busy_timeout still applies so reads wait
 * out a checkpoint instead of failing with SQLITE_BUSY.
 *
 * Fail-soft: returns `null` when the file cannot be opened (e.g. a fresh
 * install where the daemon has not created it yet) — never falls back to a
 * read-write open, which would make this process a second writer and could
 * create the file before the daemon does. Callers tolerate `null` and retry
 * on a later cycle.
 */
export function getMainDbReadOnly(): DrizzleDb | null {
  const existing = getStoredDb<DrizzleDb>("main-readonly");
  if (existing) {
    return existing;
  }
  assertTestDbIsIsolated();
  try {
    const sqlite = new Database(getDbPath(), { readonly: true });
    sqlite.exec(`PRAGMA busy_timeout=${SQLITE_BUSY_TIMEOUT_MS}`);
    const db = drizzle(sqlite, { schema });
    setStoredDb("main-readonly", db, () => sqlite.close());
    return db;
  } catch (err) {
    void import("../util/logger.js").then(({ getLogger }) =>
      getLogger("db-connection").warn(
        { err },
        "Failed to open the main database read-only; retried on next access",
      ),
    );
    return null;
  }
}

/**
 * Whether the main assistant DB connection is currently open. Lets exit paths
 * decide between DB teardown work and skipping it entirely — `getDb()` /
 * `getSqlite()` lazily open the connection, so probing with those would
 * create the very state being checked for.
 */
export function isDbOpen(): boolean {
  return getStoredDb<DrizzleDb>("main") !== null;
}

/**
 * Get the underlying bun:sqlite Database from the global Drizzle instance.
 *
 * Use this instead of the raw cast `(db as unknown as { $client: Database }).$client`.
 * See raw-query.ts for typed query helpers and guidelines on when raw SQL is appropriate.
 */
export function getSqlite(): Database {
  return getSqliteFrom(getDb());
}

/**
 * Extract the underlying bun:sqlite Database from any Drizzle instance.
 * Useful in migrations and tests that receive the Drizzle instance as a parameter.
 */
export function getSqliteFrom(drizzleDb: DrizzleDb): Database {
  // Drizzle's bun:sqlite adapter stores the raw Database as $client but
  // doesn't expose it in its public type. This is the single canonical
  // location for this cast — all callers should use getSqlite/getSqliteFrom.
  return (drizzleDb as unknown as { $client: Database }).$client;
}

/**
 * Open a dedicated bun:sqlite connection to `dbPath`, apply the standard
 * PRAGMAs, and return its Drizzle instance — caching both in the given
 * singleton slot. The connection only opens the file and sets PRAGMAs; it
 * never runs DDL (table/index creation lives in the migrations).
 *
 * Fail-soft: on any open error we log and return `null` rather than throwing,
 * consistent with the daemon's "never block startup on a subsystem failure"
 * policy. The logger is pulled in lazily (dynamic import) only on the error
 * path so this file stays import-light. Callers tolerate a `null` result.
 */
function openDedicatedDb(
  key: "logs" | "memory" | "telemetry",
  dbPath: string,
): DrizzleDb | null {
  assertTestDbIsIsolated();
  ensureDataDir();
  try {
    const sqlite = new Database(dbPath);
    applyConnectionPragmas(sqlite);
    wrapSqliteForSlowQueryLogging(sqlite);
    const db = drizzle(sqlite, { schema });
    setStoredDb(key, db, () => sqlite.close());
    return db;
  } catch (err) {
    void import("../util/logger.js").then(({ getLogger }) =>
      getLogger("db-connection").error(
        { err, dbPath, key },
        "Failed to open dedicated database; its tables will be unavailable",
      ),
    );
    return null;
  }
}

/**
 * The append-only logs database (`assistant-logs.db`), opened lazily as its
 * own connection. Houses `llm_request_logs`. Returns `null` if the file
 * cannot be opened (logged; the daemon stays up).
 */
export function getLogsDb(): DrizzleDb | null {
  const existing = getStoredDb<DrizzleDb>("logs");
  if (existing) {
    return existing;
  }
  return openDedicatedDb("logs", getLogsDbPath());
}

/** Underlying bun:sqlite Database for the logs connection, or `null`. */
export function getLogsSqlite(): Database | null {
  const db = getLogsDb();
  return db ? getSqliteFrom(db) : null;
}

/**
 * The high-churn memory database (`assistant-memory.db`), opened lazily as
 * its own connection. Houses `memory_jobs`. Returns `null` if the file
 * cannot be opened (logged; the daemon stays up).
 */
export function getMemoryDb(): DrizzleDb | null {
  const existing = getStoredDb<DrizzleDb>("memory");
  if (existing) {
    return existing;
  }
  return openDedicatedDb("memory", getMemoryDbPath());
}

/** Underlying bun:sqlite Database for the memory connection, or `null`. */
export function getMemorySqlite(): Database | null {
  const db = getMemoryDb();
  return db ? getSqliteFrom(db) : null;
}

/**
 * The telemetry database (`assistant-telemetry.db`), opened lazily as its own
 * connection. Houses the telemetry-only event tables (see
 * `util/telemetry-db-path.ts` for the list).
 * Returns `null` if the file cannot be opened (logged; the daemon stays up).
 */
export function getTelemetryDb(): DrizzleDb | null {
  const existing = getStoredDb<DrizzleDb>("telemetry");
  if (existing) {
    return existing;
  }
  return openDedicatedDb("telemetry", getTelemetryDbPath());
}

/** Underlying bun:sqlite Database for the telemetry connection, or `null`. */
export function getTelemetrySqlite(): Database | null {
  const db = getTelemetryDb();
  return db ? getSqliteFrom(db) : null;
}

/**
 * Reset all DB singletons. Used by production callers that need to close the
 * live connections so the files can be replaced (post-migration, post-restore,
 * post-vbundle-import) and on graceful shutdown. Clears the main, logs, memory,
 * and telemetry slots together so none lingers open against a swapped-out file.
 *
 * Tests should use `resetDbForTesting()` from
 * `__tests__/db-test-helpers.ts` instead so they don't depend on this
 * module's heavy import chain (`drizzle-orm/bun-sqlite`).
 */
export function resetDb(): void {
  clearStoredDb("main");
  clearStoredDb("main-readonly");
  clearStoredDb("logs");
  clearStoredDb("memory");
  clearStoredDb("telemetry");
}
