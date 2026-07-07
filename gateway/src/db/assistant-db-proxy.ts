/**
 * Data-migrations-only bridge for executing SQL against the assistant's
 * SQLite database via IPC. Gateway one-time data migrations (m0002, m0010,
 * m0014, et al.) need raw read/drop access to the assistant DB on first boot
 * of upgraded installs, and direct cross-container file access corrupts the
 * DB on platform pods (fcntl locks are not shared across mount namespaces +
 * a SQLite WAL-reset bug in ≤3.51.2) — so migrations reach the assistant DB
 * only through this route.
 *
 * No runtime feature may use this surface. The caller allowlist — this
 * module plus `db/data-migrations/` — is enforced by
 * `__tests__/db-proxy-allowlist.test.ts`.
 */

import { ipcCallAssistant } from "../ipc/assistant-client.js";

export type SqliteValue = string | number | null | Uint8Array;

interface DbProxyResult {
  rows?: Record<string, SqliteValue>[];
  changes?: number;
  lastInsertRowid?: number;
}

async function dbProxy(
  sql: string,
  mode: "query" | "run" | "exec",
  bind?: SqliteValue[],
): Promise<DbProxyResult> {
  return (await ipcCallAssistant("db_proxy", {
    sql,
    mode,
    bind,
  })) as DbProxyResult;
}

/**
 * Execute a SELECT and return all matching rows.
 */
export async function assistantDbQuery<T = Record<string, SqliteValue>>(
  sql: string,
  bind?: SqliteValue[],
): Promise<T[]> {
  const result = await dbProxy(sql, "query", bind);
  return (result.rows ?? []) as T[];
}

/**
 * Execute an INSERT/UPDATE/DELETE and return change metadata.
 */
export async function assistantDbRun(
  sql: string,
  bind?: SqliteValue[],
): Promise<{ changes: number; lastInsertRowid: number }> {
  const result = await dbProxy(sql, "run", bind);
  return {
    changes: result.changes ?? 0,
    lastInsertRowid: result.lastInsertRowid ?? 0,
  };
}

/**
 * Execute raw SQL (DDL, PRAGMA, multi-statement). Returns nothing.
 */
export async function assistantDbExec(sql: string): Promise<void> {
  await dbProxy(sql, "exec");
}
