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

// ---------------------------------------------------------------------------
// Transaction helper
// ---------------------------------------------------------------------------

export interface AssistantDbTransactionStep {
  /** The SQL write statement to execute. */
  sql: string;
  /** Positional bind parameters. */
  bind?: SqliteValue[];
  /**
   * If set, abort the transaction (rollback) when this step's row-change
   * count is below this threshold. Used for stale-write detection — e.g.
   * "increment use_count only if status = 'active' AND use_count < max_uses",
   * with `requireChanges: 1` to abort when no rows match.
   */
  requireChanges?: number;
}

export type AssistantDbTransactionResult =
  | {
      ok: true;
      results: Array<{ changes: number; lastInsertRowid: number }>;
    }
  | {
      ok: false;
      reason: "require_changes_failed";
      failedStep: number;
      actualChanges: number;
      requiredChanges: number;
    };

/**
 * Execute multiple write statements against the assistant's SQLite DB inside
 * a single atomic transaction (BEGIN IMMEDIATE). All steps commit together;
 * any throw — including a `requireChanges` constraint failure — rolls back
 * the entire batch.
 *
 * Use this when several writes must succeed or fail as a unit (e.g. invite
 * redemption: contact-channel upsert + invite-use record).
 *
 * Read-modify-write across steps is not supported. Use SQL-level conditions
 * (WHERE clauses, ON CONFLICT) plus `requireChanges` for stale-write detection.
 */
export async function assistantDbTransaction(
  steps: AssistantDbTransactionStep[],
): Promise<AssistantDbTransactionResult> {
  const result = await ipcCallAssistant("db_proxy_transaction", { steps });
  if (result === undefined) {
    throw new Error(
      "db_proxy_transaction IPC call failed — assistant may not be ready",
    );
  }
  return result as AssistantDbTransactionResult;
}
