import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { Database } from "bun:sqlite";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getLogger } from "../util/logger.js";
import { ensureDataDir, getDbPath, getLogsDbPath } from "../util/platform.js";
import { clearStoredDb, getStoredDb, setStoredDb } from "./db-singleton.js";
import * as schema from "./schema.js";

export type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

const log = getLogger("db-connection");

/**
 * Schema name under which the secondary append-only database file
 * (`assistant-logs.db`) is ATTACHed to the main connection. Tables created in
 * this schema (e.g. `logs.llm_request_logs`) live in the separate file but are
 * still queryable — and joinable against main-schema tables — over the single
 * daemon connection. Because no append-only table exists in the `main` schema,
 * unqualified references (e.g. `llm_request_logs`) resolve to the attached copy.
 */
export const LOGS_DB_SCHEMA = "logs";

/**
 * ATTACH the append-only logs database to an open connection and apply its
 * per-database PRAGMAs.
 *
 * `journal_mode` and `synchronous` are per-database settings, so they must be
 * set against the attached schema explicitly — the PRAGMAs run on `main` before
 * the attach do not carry over. `busy_timeout`, `foreign_keys`, `cache_size`,
 * and `temp_store` are connection-wide and already configured on the connection.
 *
 * Best-effort: a failure here (e.g. a filesystem permission problem on the new
 * file) must not take down the main database. We log and continue in line with
 * the daemon's "never block startup on a subsystem failure" policy; append-only
 * tables are simply unavailable until the next successful open.
 */
function attachLogsDb(sqlite: Database): void {
  const logsPath = getLogsDbPath();
  try {
    // Escape single quotes for the SQL string literal (paths can contain them).
    const escaped = logsPath.replace(/'/g, "''");
    sqlite.exec(`ATTACH DATABASE '${escaped}' AS ${LOGS_DB_SCHEMA}`);
    sqlite.exec(`PRAGMA ${LOGS_DB_SCHEMA}.journal_mode=WAL`);
    sqlite.exec(`PRAGMA ${LOGS_DB_SCHEMA}.synchronous=FULL`);
  } catch (err) {
    log.error(
      { err, logsPath },
      "Failed to ATTACH logs database; append-only log tables will be unavailable",
    );
  }
}

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

function assertTestDbIsIsolated(): void {
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

export function getDb(): DrizzleDb {
  const existing = getStoredDb<DrizzleDb>();
  if (existing) return existing;

  assertTestDbIsIsolated();
  ensureDataDir();
  const sqlite = new Database(getDbPath());
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA synchronous=FULL");
  sqlite.exec("PRAGMA busy_timeout=5000");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec("PRAGMA cache_size=-256000");
  sqlite.exec("PRAGMA temp_store=MEMORY");
  attachLogsDb(sqlite);
  const db = drizzle(sqlite, { schema });
  setStoredDb(db, () => sqlite.close());
  return db;
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
 * Reset the db singleton. Used by production callers that need to close
 * the live connection so the file can be replaced (post-migration,
 * post-restore, post-vbundle-import) and on graceful shutdown.
 *
 * Tests should use `resetDbForTesting()` from
 * `__tests__/db-test-helpers.ts` instead so they don't depend on this
 * module's heavy import chain (`drizzle-orm/bun-sqlite`).
 */
export function resetDb(): void {
  clearStoredDb();
}
