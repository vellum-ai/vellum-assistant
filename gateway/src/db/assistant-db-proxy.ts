/**
 * ⚠️  TEMPORARY HACK — DO NOT EXTEND ⚠️
 *
 * Proxy for executing SQL against the assistant's SQLite database via IPC,
 * replacing the direct file access in `getAssistantDb()` that caused
 * database corruption on platform pods (cross-container fcntl lock
 * incompatibility + SQLite WAL-reset bug in ≤3.51.2).
 *
 * Provides a minimal Database-like interface so callers can migrate from
 * `getAssistantDb()` with minimal diff. NOT a general-purpose query layer.
 *
 * Remove this once all contacts/guardian-binding logic is migrated to the
 * gateway's own database.
 */

import { ipcCallAssistant } from "../ipc/assistant-client.js";

type SqliteValue = string | number | null | Uint8Array;

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
  const result = await ipcCallAssistant("db_proxy", { sql, mode, bind });
  if (result === undefined) {
    throw new Error("db_proxy IPC call failed — assistant may not be ready");
  }
  return result as DbProxyResult;
}

/**
 * Execute a SELECT and return all matching rows.
 */
export async function assistantDbQuery<T extends Record<string, SqliteValue>>(
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
