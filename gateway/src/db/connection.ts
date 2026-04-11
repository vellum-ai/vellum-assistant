import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getGatewaySecurityDir } from "../config.js";

let db: Database | null = null;

function getDbPath(): string {
  const securityDir = getGatewaySecurityDir();
  if (!existsSync(securityDir)) {
    mkdirSync(securityDir, { recursive: true });
  }
  return join(securityDir, "gateway.sqlite");
}

export function getGatewayDb(): Database {
  if (!db) {
    db = new Database(getDbPath());
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA synchronous=FULL");
    db.exec("PRAGMA busy_timeout=5000");
    db.exec("PRAGMA foreign_keys=ON");
    migrate(db);
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
}
