import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function getDbPath(): string {
  const baseDir = process.env.BASE_DATA_DIR?.trim() || homedir();
  return join(baseDir, ".vellum", "workspace", "data", "db", "assistant.db");
}

let db: Database | null = null;

export function getDb(): Database {
  if (!db) {
    const dbPath = getDbPath();
    mkdirSync(join(dbPath, ".."), { recursive: true });
    db = new Database(dbPath);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA busy_timeout=5000");
    db.exec("PRAGMA foreign_keys = ON");
  }
  return db;
}
