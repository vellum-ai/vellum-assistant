// ---------------------------------------------------------------------------
// Conversation-row batch delete — off-event-loop bulk delete of a
// conversation's rows from one table.
// ---------------------------------------------------------------------------
//
// Deleting a conversation that owns a large history is expensive on two tables:
// the `messages` rows (potentially an entire copied conversation history) and
// the `llm_request_logs` rows (one bulky row per model call). Done in-process
// via `bun:sqlite`, a single `DELETE FROM <table> WHERE conversation_id = ?` is
// one implicit transaction that holds the write lock for its full duration — on
// a multi-GB database it pegs the CPU and a concurrent in-process write (a live
// user turn persisting a message) blocks up to `busy_timeout` and can throw
// `SQLITE_BUSY`.
//
// This module deletes those rows off the event loop via {@link runAsyncSqlite}
// (a `sqlite3` CLI subprocess with its own connection; SQLite file-locking
// arbitrates with the in-process handle), in lock-friendly batches that each
// auto-commit and yield. Two properties matter for correctness:
//
//   1. **Lock-friendly batching.** Each batch deletes at most `batchSize` rows
//      in one auto-committing `DELETE` (no surrounding `BEGIN`), releasing the
//      write lock between batches, and a brief yield between subprocess calls
//      lets a contending foreground write reliably slip in instead of losing
//      every race to the delete's greedy lock re-acquisition.
//
//   2. **Cascade parity.** The in-process delete runs on the daemon connection,
//      which has `PRAGMA foreign_keys = ON` (`db-connection.ts`), so deleting a
//      `messages` row cascades to its `memory_segments`, `message_attachments`,
//      `bookmarks`, and `channel_inbound_events` rows. A fresh `sqlite3`
//      subprocess connection defaults to foreign keys OFF, so set
//      `enableForeignKeys` for tables whose delete must cascade — otherwise the
//      dependent rows would be orphaned. (`memory_embeddings` is not FK-linked
//      to segments; the caller deletes those explicitly.)

import { setTimeout as sleep } from "node:timers/promises";

import {
  type AsyncSqliteBackend,
  type AsyncSqliteResult,
  parseChangesFromStdout,
  runAsyncSqlite,
  type RunAsyncSqliteOptions,
} from "./db-async-query.js";

/**
 * Default batch size for the chunked delete. Each batch is one `DELETE` that
 * auto-commits, so this bounds how long the subprocess holds the write lock
 * before releasing it to in-process writers; the worst-case wait for a
 * contending foreground write is one batch, and delete latency doesn't matter
 * (nobody waits on a background GC).
 *
 * A deleted row costs a plain b-tree delete plus any FK cascade deletes —
 * cheap and roughly proportional to the row count, with no per-row trigger
 * work — so a batch this size still holds the lock only briefly while
 * amortizing the per-batch subprocess spawn cost.
 */
export const DEFAULT_DELETE_BATCH_SIZE = 200;

/**
 * Pause inserted between batch subprocess calls. Without it the delete releases
 * the write lock on each batch's auto-commit but greedily re-acquires it
 * microseconds later, so a concurrent in-process writer (a live user turn
 * persisting a message) can lose every race. A brief yield lets foreground
 * writes reliably slip in between batches. The extra delete latency is free —
 * nothing waits on a background GC — so we trade delete speed for foreground
 * fairness.
 */
export const DEFAULT_DELETE_INTER_BATCH_DELAY_MS = 25;

export interface DeleteConversationRowsOptions {
  /** The conversation whose rows should be deleted. */
  conversationId: string;
  /** Table to delete from (e.g. `messages`, `llm_request_logs`). */
  table: string;
  /** Column holding the conversation id on `table`. Defaults to `conversation_id`. */
  conversationColumn?: string;
  /**
   * Target a dedicated database file (e.g. `getLogsDbPath()` for
   * `llm_request_logs`). Defaults to the main assistant DB.
   */
  dbPath?: string;
  /**
   * Enable `PRAGMA foreign_keys=ON` so the delete cascades to FK-dependent
   * rows. Required when deleting `messages`; unnecessary for tables with no
   * dependents.
   */
  enableForeignKeys?: boolean;
  /** Override the per-batch row count (see {@link DEFAULT_DELETE_BATCH_SIZE}). */
  batchSize?: number;
  /** Test-only passthrough to force the in-process backend. */
  forceInProcess?: boolean;
}

// Server-generated ids only ever use this charset. We interpolate the
// conversation id (never row content) into the SQL script, so reject anything
// outside it as a defense-in-depth guard against a malformed id breaking out of
// the literal.
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
// Table/column identifiers are interpolated unquoted, so constrain them to a
// plain SQL identifier shape. Call sites pass compile-time constants, but this
// keeps the interpolation safe regardless.
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertSafeId(id: string): void {
  if (!SAFE_ID.test(id)) {
    throw new Error(
      `conversation-row delete: unsafe id literal: ${JSON.stringify(id)}`,
    );
  }
}

function assertSafeIdentifier(name: string, kind: string): void {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(
      `conversation-row delete: unsafe ${kind} identifier: ${JSON.stringify(name)}`,
    );
  }
}

/**
 * Build the SQL script for one delete batch: optionally enable cascading
 * deletes, remove up to `batchSize` of the conversation's remaining rows, and
 * print the direct-delete count via `SELECT changes()` so the caller can tell
 * when the conversation is drained. `changes()` counts only the rows deleted
 * from `table` (not cascade/trigger rows), so it strictly decreases the
 * remaining count and is a sound loop terminator. Exported for unit testing the
 * generated SQL without spawning a subprocess.
 */
export function buildBatchDeleteScript(options: {
  conversationId: string;
  table: string;
  conversationColumn?: string;
  enableForeignKeys?: boolean;
  batchSize: number;
}): string {
  assertSafeId(options.conversationId);
  assertSafeIdentifier(options.table, "table");
  const column = options.conversationColumn ?? "conversation_id";
  assertSafeIdentifier(column, "column");
  const limit = Math.max(1, options.batchSize);
  const fkPragma = options.enableForeignKeys ? "PRAGMA foreign_keys=ON;\n" : "";
  return `${fkPragma}DELETE FROM ${options.table} WHERE rowid IN (
  SELECT rowid FROM ${options.table} WHERE ${column} = '${options.conversationId}' LIMIT ${limit}
);
SELECT changes();`;
}

/**
 * Delete a conversation's rows from one table off the event loop, in
 * lock-friendly batches. Each batch runs as its own subprocess call with a
 * brief yield in between (see {@link DEFAULT_DELETE_INTER_BATCH_DELAY_MS}) so
 * foreground writers reliably acquire the write lock between batches instead of
 * losing every race to the delete's greedy lock re-acquisition. Loops until a
 * batch deletes fewer rows than the batch size (the table is drained for this
 * conversation), and resolves once every batch has committed — or returns the
 * failing batch's `ok: false` result on subprocess failure, leaving any
 * already-deleted rows gone (the caller's GC is best-effort and an orphan sweep
 * is the backstop).
 *
 * Only this table's rows (and, when `enableForeignKeys` is set, their FK
 * cascades) are removed; the caller is responsible for the remaining tables and
 * the conversation row.
 */
export async function deleteConversationRowsInBatches(
  options: DeleteConversationRowsOptions,
): Promise<AsyncSqliteResult> {
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_DELETE_BATCH_SIZE);
  const runOptions: RunAsyncSqliteOptions = {};
  if (options.forceInProcess) {
    runOptions.forceBackend = "in-process-blocking";
  }
  if (options.dbPath !== undefined) {
    runOptions.dbPath = options.dbPath;
  }

  let totalElapsedMs = 0;
  let backend: AsyncSqliteBackend = "in-process-blocking";

  // Loop until a batch deletes fewer rows than requested — that batch drained
  // the remaining rows, so there is nothing left to delete. Each DELETE
  // strictly shrinks the row set, so the loop always terminates.
  for (;;) {
    const sql = buildBatchDeleteScript({
      conversationId: options.conversationId,
      table: options.table,
      conversationColumn: options.conversationColumn,
      enableForeignKeys: options.enableForeignKeys,
      batchSize,
    });
    const result = await runAsyncSqlite(
      sql,
      `conversation-row-delete:${options.table}:${options.conversationId}`,
      runOptions,
    );
    totalElapsedMs += result.elapsedMs;
    backend = result.backend;
    if (!result.ok) {
      return { ...result, elapsedMs: totalElapsedMs };
    }

    const deleted = parseChangesFromStdout(result.stdout);
    if (deleted < batchSize) {
      break;
    }
    await sleep(DEFAULT_DELETE_INTER_BATCH_DELAY_MS);
  }

  return { ok: true, backend, error: null, elapsedMs: totalElapsedMs };
}
