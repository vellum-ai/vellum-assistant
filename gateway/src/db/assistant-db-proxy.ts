/**
 * ⚠️  TEMPORARY HACK — DO NOT EXTEND ⚠️
 *
 * Proxy for executing SQL against the assistant's SQLite database via IPC.
 * Direct cross-container file access corrupts the DB on platform pods (fcntl
 * locks are not shared across mount namespaces + a SQLite WAL-reset bug in
 * ≤3.51.2), so the gateway reaches the assistant DB only through this route.
 *
 * The caller allowlist is pinned by `__tests__/db-proxy-allowlist.test.ts`.
 * The surface serves exactly three groups:
 *   (a) the contact-merge identity-mirror cluster in `db/contact-store.ts` —
 *       pending a merge-shaped op that expresses a notes-only survivor UPDATE
 *       and a resolved-slug dual-write INSERT the typed mirror ops cannot,
 *   (b) data migrations (one-time backfills and drops), and
 *   (c) residual raw-SQL contact reads in `verification/contact-helpers.ts`
 *       (deferred cleanup).
 *
 * NOT a general-purpose query layer. Slated for removal once the
 * contact-merge cluster gets typed mirror ops.
 */

import {
  IpcHandlerError,
  ipcCallAssistant,
} from "../ipc/assistant-client.js";

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
 * Error handling:
 * - `requireChanges` violations return `{ ok: false, reason: "require_changes_failed", ... }`.
 * - Handler-level failures (SQL constraint errors, malformed params) throw
 *   `IpcHandlerError` so the underlying SQL message is preserved.
 * - Transport failures (socket missing, daemon unreachable, timeout) throw
 *   `IpcTransportError`. Use this to distinguish retryable vs.
 *   non-retryable failures.
 *
 * Read-modify-write across steps is not supported. Use SQL-level conditions
 * (WHERE clauses, ON CONFLICT) plus `requireChanges` for stale-write detection.
 */
export async function assistantDbTransaction(
  steps: AssistantDbTransactionStep[],
): Promise<AssistantDbTransactionResult> {
  return (await ipcCallAssistant("db_proxy_transaction", {
    steps,
  })) as AssistantDbTransactionResult;
}

/**
 * Re-export so callers in this module's domain (gateway DB write helpers)
 * can identify SQL/handler failures from the assistant DB proxy without
 * importing from the IPC client directly.
 */
export { IpcHandlerError };
