import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir, userInfo } from "node:os";
import { getGatewaySecurityDir } from "../paths.js";
import { runDataMigrations } from "./data-migrations/index.js";

let db: Database | null = null;

function safeUserInfoHomedir(): string {
  try {
    return userInfo().homedir;
  } catch {
    return "";
  }
}

/**
 * @deprecated Only used for one-time migration from the legacy DB path.
 * Replicates the old getRootDir() logic inline so we don't depend on
 * credential-reader.ts (getRootDir is being removed). Respects
 * BASE_DATA_DIR for multi-instance local setups where the CLI sets it
 * to the instance directory.
 *
 * Home fallback chain: `$HOME` → `userInfo().homedir` → `homedir()`.
 * `homedir()` alone is insufficient because libuv's `uv_os_homedir` returns
 * `$HOME` as-is when set (even to `""`) and only consults `getpwuid_r` when
 * `HOME` is unset entirely. `userInfo()` calls `getpwuid_r` directly, so it
 * returns the passwd-table home regardless of `HOME`. The `userInfo()` call
 * is guarded via `safeUserInfoHomedir()` because it throws `SystemError`
 * when the current UID has no passwd entry (common in containers run with
 * `--user <uid>` without a matching `/etc/passwd` line); catching keeps the
 * `homedir()` fallback reachable.
 */
export function getLegacyRootDir(): string {
  return join(
    process.env.BASE_DATA_DIR?.trim() ||
      process.env.HOME ||
      safeUserInfoHomedir() ||
      homedir(),
    ".vellum",
  );
}

/**
 * One-time migration: move gateway.sqlite from the legacy path
 * (~/.vellum/data/gateway.sqlite) to the new PVC-backed path
 * ({gatewaySecurityDir}/gateway.sqlite). Idempotent — skips if
 * the new path already exists or the old path doesn't.
 */
function migrateLegacyDb(newPath: string): void {
  const legacyPath = join(getLegacyRootDir(), "data", "gateway.sqlite");
  if (legacyPath === newPath) return;
  if (existsSync(newPath)) return;
  if (!existsSync(legacyPath)) return;

  try {
    renameSync(legacyPath, newPath);
  } catch {
    // Cross-device rename not possible (e.g. Docker volumes) — the
    // legacy DB was on ephemeral storage anyway, so just let the
    // new DB be created fresh.
    return;
  }

  // Move WAL/SHM sidecar files if present. Done in a separate
  // try/catch so a sidecar failure doesn't mask that the main
  // DB file was already moved successfully.
  for (const suffix of ["-wal", "-shm"]) {
    try {
      const old = legacyPath + suffix;
      if (existsSync(old)) renameSync(old, newPath + suffix);
    } catch {
      // Best-effort — SQLite will recover from a missing WAL/SHM
      // by rolling back to the last checkpointed state.
    }
  }
}

function getDbPath(): string {
  const securityDir = getGatewaySecurityDir();
  if (!existsSync(securityDir)) {
    mkdirSync(securityDir, { recursive: true });
  }
  const dbPath = join(securityDir, "gateway.sqlite");
  migrateLegacyDb(dbPath);
  return dbPath;
}

export function getGatewayDb(): Database {
  if (!db) {
    db = new Database(getDbPath());
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA synchronous=FULL");
    db.exec("PRAGMA busy_timeout=5000");
    db.exec("PRAGMA foreign_keys=ON");
    migrate(db);
    runDataMigrations(db);
  }
  return db;
}

function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS slack_active_threads (
      thread_ts TEXT PRIMARY KEY,
      tracked_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS slack_seen_events (
      event_id TEXT PRIMARY KEY,
      seen_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS one_time_migrations (
      key TEXT PRIMARY KEY,
      ran_at INTEGER NOT NULL
    )
  `);
}
