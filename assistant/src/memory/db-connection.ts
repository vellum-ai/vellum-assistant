import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import * as schema from './schema.js';
import { getDbPath, ensureDataDir, migrateToDataLayout, migrateToWorkspaceLayout } from '../util/platform.js';

let db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (!db) {
    migrateToDataLayout();
    migrateToWorkspaceLayout();
    ensureDataDir();
    const sqlite = new Database(getDbPath());
    sqlite.exec('PRAGMA journal_mode=WAL');
    sqlite.exec('PRAGMA foreign_keys = ON');
    db = drizzle(sqlite, { schema });
  }
  return db;
}

/** Reset the db singleton. Used by tests to ensure isolation between test files. */
export function resetDb(): void {
  if (db) {
    const raw = (db as unknown as { $client: Database }).$client;
    raw.close();
    db = null;
  }
}
