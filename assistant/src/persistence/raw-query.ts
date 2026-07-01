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

import type { Database, SQLQueryBindings } from "bun:sqlite";

import { getLogsSqlite, getMemorySqlite, getSqlite } from "./db-connection.js";

type SqlParam = SQLQueryBindings;

// ---------------------------------------------------------------------------
// Typed query helpers (global Drizzle instance)
// ---------------------------------------------------------------------------
//
// Slow-query attribution is handled centrally: every connection returned by the
// db-connection accessor is wrapped by `wrapSqliteForSlowQueryLogging`, which
// times each `.get()/.all()/.run()` execution below. These helpers therefore
// stay pure passthroughs — wrapping them again here would double-log the same
// slow statement.

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

// ---------------------------------------------------------------------------
// Typed query helpers for the dedicated memory connection (assistant-memory.db)
// ---------------------------------------------------------------------------

/** The memory connection, or a thrown error when it cannot be opened. */
function memorySqlite(): Database {
  const sqlite = getMemorySqlite();
  if (!sqlite) throw new Error("memory database unavailable");
  return sqlite;
}

/** The logs connection, or a thrown error when it cannot be opened. */
function logsSqlite(): Database {
  const sqlite = getLogsSqlite();
  if (!sqlite) throw new Error("logs database unavailable");
  return sqlite;
}

/** {@link rawAll} against the memory connection. */
export function rawMemoryAll<T>(sql: string, ...params: SqlParam[]): T[] {
  return memorySqlite()
    .query(sql)
    .all(...params) as T[];
}

/** {@link rawRun} against the memory connection. */
export function rawMemoryRun(sql: string, ...params: SqlParam[]): number {
  const sqlite = memorySqlite();
  sqlite.query(sql).run(...params);
  return (sqlite.query("SELECT changes() AS c").get() as { c: number }).c;
}

/** {@link rawChanges} against the memory connection. */
export function rawMemoryChanges(): number {
  return (memorySqlite().query("SELECT changes() AS c").get() as { c: number })
    .c;
}

/** {@link rawRun} against the logs connection. */
export function rawLogsRun(sql: string, ...params: SqlParam[]): number {
  const sqlite = logsSqlite();
  sqlite.query(sql).run(...params);
  return (sqlite.query("SELECT changes() AS c").get() as { c: number }).c;
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
