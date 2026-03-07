import { Database } from "bun:sqlite";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { ensureDataDir, getDbPath } from "../util/platform.js";
import * as schema from "./schema.js";

export type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

let db: DrizzleDb | null = null;

export function getDb(): DrizzleDb {
  if (!db) {
    ensureDataDir();
    const sqlite = new Database(getDbPath());
    sqlite.exec("PRAGMA journal_mode=WAL");
    sqlite.exec("PRAGMA synchronous=FULL");
    sqlite.exec("PRAGMA busy_timeout=5000");
    sqlite.exec("PRAGMA foreign_keys = ON");
    sqlite.exec("PRAGMA cache_size=-256000");
    sqlite.exec("PRAGMA temp_store=MEMORY");
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
  // Drizzle's bun:sqlite adapter stores the raw Database as $client but
  // doesn't expose it in its public type. This is the single canonical
  // location for this cast — all callers should use getSqlite/getSqliteFrom.
  return (drizzleDb as unknown as { $client: Database }).$client;
}

/** Reset the db singleton. Used by tests to ensure isolation between test files. */
export function resetDb(): void {
  if (db) {
    getSqliteFrom(db).close();
    db = null;
  }
}
