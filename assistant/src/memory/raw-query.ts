/**
 * Type-safe wrappers for raw SQL queries against bun:sqlite.
 *
 * ## When to use raw SQL vs Drizzle ORM
 *
 * **Default to Drizzle** for all standard CRUD operations. Use raw SQL only when
 * Drizzle cannot express the query or when a raw API is required:
 *
 * - **FTS5 operations**: MATCH operator, bm25() ranking, virtual table
 *   INSERT/DELETE. Drizzle has no FTS5 support.
 *
 * - **Schema migrations**: DDL statements (CREATE TABLE, ALTER TABLE, DROP TABLE),
 *   PRAGMA control, and transaction-wrapped table rebuilds. These are structural
 *   operations outside Drizzle's query-building scope.
 *
 * - **Affected-row checks after Drizzle .run()**: Drizzle's bun:sqlite adapter
 *   returns void from .run(), so checking changes() requires the raw client.
 *   Use `rawChanges()` for this.
 *
 * - **INSERT OR IGNORE / ON CONFLICT**: SQLite-specific upsert syntax that
 *   Drizzle's bun:sqlite adapter doesn't fully support.
 *
 * - **Atomic in-place updates**: Expressions like `SET count = count + 1` can
 *   use Drizzle's `sql` template, but raw SQL is acceptable when simpler.
 *
 * - **Bulk deletes across virtual tables**: Operations like clearing
 *   messages_fts that reference virtual tables not modeled in Drizzle.
 *
 * For everything else — selects, inserts, updates, deletes, joins, aggregations,
 * filtering, ordering, pagination — use Drizzle.
 */

import type { SQLQueryBindings } from "bun:sqlite";

import { getSqlite } from "./db-connection.js";

type SqlParam = SQLQueryBindings;

// ---------------------------------------------------------------------------
// Typed query helpers (global Drizzle instance)
// ---------------------------------------------------------------------------

/** Execute a raw SQL query and return a single typed row, or null if no match. */
export function rawGet<T>(sql: string, ...params: SqlParam[]): T | null {
  return (
    (getSqlite()
      .query(sql)
      .get(...params) as T) ?? null
  );
}

/** Execute a raw SQL query and return all matching rows with type safety. */
export function rawAll<T>(sql: string, ...params: SqlParam[]): T[] {
  return getSqlite()
    .query(sql)
    .all(...params) as T[];
}

/**
 * Execute a raw SQL statement (INSERT/UPDATE/DELETE) and return the number
 * of affected rows.
 */
export function rawRun(sql: string, ...params: SqlParam[]): number {
  getSqlite()
    .query(sql)
    .run(...params);
  return rawChanges();
}

/** Execute batch SQL (multiple statements, no bindings). */
export function rawExec(sql: string): void {
  getSqlite().exec(sql);
}

/**
 * Return the number of rows affected by the most recent INSERT/UPDATE/DELETE.
 *
 * Useful after a Drizzle `.run()` call, since Drizzle's bun:sqlite adapter
 * returns void and discards the changes count.
 */
export function rawChanges(): number {
  return (getSqlite().query("SELECT changes() AS c").get() as { c: number }).c;
}

/**
 * Delete all rows from the given tables in a single transaction.
 *
 * Without an explicit transaction, each DELETE is auto-committed with its own
 * fsync. Batching them saves ~10-20ms per DELETE statement — significant in
 * test files that clear 10-15 tables in every `beforeEach`.
 */
export function resetTestTables(...tables: string[]): void {
  const sqlite = getSqlite();
  const deletes = tables.map((t) => `DELETE FROM "${t}"`).join(";\n");
  sqlite.exec("BEGIN");
  try {
    sqlite.exec(deletes);
    sqlite.exec("COMMIT");
  } catch (e) {
    sqlite.exec("ROLLBACK");
    throw e;
  }
}
