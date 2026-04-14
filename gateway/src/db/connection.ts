import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { getGatewaySecurityDir, getLegacyRootDir } from "../paths.js";
import { runDataMigrations } from "./data-migrations/index.js";

let db: Database | null = null;

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
