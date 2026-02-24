import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import * as schema from './schema.js';
import { getDbPath, ensureDataDir, migrateToDataLayout, migrateToWorkspaceLayout } from '../util/platform.js';

export type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

let db: DrizzleDb | null = null;

export function getDb(): DrizzleDb {
  if (!db) {
    migrateToDataLayout();
    migrateToWorkspaceLayout();
    ensureDataDir();
    const sqlite = new Database(getDbPath());
    sqlite.exec('PRAGMA journal_mode=WAL');
    sqlite.exec('PRAGMA busy_timeout=5000');
    sqlite.exec('PRAGMA foreign_keys = ON');
    db = drizzle(sqlite, { schema });
  }
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
  return (drizzleDb as unknown as { $client: Database }).$client;
}

/** Reset the db singleton. Used by tests to ensure isolation between test files. */
export function resetDb(): void {
  if (db) {
    getSqliteFrom(db).close();
    db = null;
  }
}
