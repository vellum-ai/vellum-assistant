// ---------------------------------------------------------------------------
// Fork message-delete — off-event-loop bulk delete of a conversation's messages.
// ---------------------------------------------------------------------------
//
// The fork-based memory retrospective GCs the superseded prior run once a newer
// run succeeds (see `deleteSupersededPriorRetrospective`). Each fork-kind run
// materializes a full copy of the source conversation's message rows, so that
// prior conversation can carry an entire conversation history. Deleting it
// in-process via `bun:sqlite` runs the whole `DELETE FROM messages` as one
// implicit transaction — the mirror image of the heavy fork copy this module's
// sibling ({@link ./fork-message-copy.ts}) moved off the event loop: on a
// multi-GB database it pegs the CPU for the full delete and holds the write
// lock the whole time, so a concurrent in-process write (a live user turn
// persisting a message) blocks up to `busy_timeout` and can throw
// `SQLITE_BUSY`.
//
// This module deletes the message rows off the event loop via
// {@link runAsyncSqlite} (a `sqlite3` CLI subprocess with its own connection;
// SQLite file-locking arbitrates with the in-process handle), in lock-friendly
// batches that each auto-commit and yield, exactly as the copy does. Two
// properties matter for correctness:
//
//   1. **Lock-friendly batching.** Each batch deletes at most `batchSize`
//      message rows in one auto-committing `DELETE` (no surrounding `BEGIN`),
//      releasing the write lock between batches, and a brief yield between
//      subprocess calls lets a contending foreground write reliably slip in
//      instead of losing every race to the delete's greedy lock re-acquisition.
//
//   2. **Cascade parity.** The in-process delete runs on the daemon connection,
//      which has `PRAGMA foreign_keys = ON` (`db-connection.ts`), so deleting a
//      message cascades to its `memory_segments`, `message_attachments`,
//      `bookmarks`, and `channel_inbound_events` rows. A fresh `sqlite3`
//      subprocess connection defaults to foreign keys OFF, so each batch script
//      enables the pragma first — otherwise the dependent rows would be
//      orphaned. (`memory_embeddings` is not FK-linked to segments; the caller
//      deletes those explicitly, as it does for the synchronous delete.)

import { setTimeout as sleep } from "node:timers/promises";

import {
  type AsyncSqliteBackend,
  type AsyncSqliteResult,
  parseChangesFromStdout,
  runAsyncSqlite,
} from "./db-async-query.js";

/**
 * Default batch size for the chunked delete. Each batch is one `DELETE` that
 * auto-commits, so this bounds how long the subprocess holds the write lock
 * before releasing it to in-process writers. Kept small (matching the fork
 * copy) so the worst-case wait for a contending foreground write is one short
 * batch, even on a bloated database; per-batch statement overhead stays
 * negligible and delete latency doesn't matter (nobody waits on a background
 * GC).
 */
export const DEFAULT_FORK_DELETE_BATCH_SIZE = 50;

/**
 * Pause inserted between batch subprocess calls. Without it the delete releases
 * the write lock on each batch's auto-commit but greedily re-acquires it
 * microseconds later, so a concurrent in-process writer (a live user turn
 * persisting a message) can lose every race. A brief yield lets foreground
 * writes reliably slip in between batches. The extra delete latency is free —
 * nothing waits on a background GC — so we trade delete speed for foreground
 * fairness.
 */
export const DEFAULT_FORK_DELETE_INTER_BATCH_DELAY_MS = 25;

export interface DeleteForkMessagesOptions {
  /** The conversation whose message rows should be deleted. */
  conversationId: string;
  /** Override the per-batch row count (see {@link DEFAULT_FORK_DELETE_BATCH_SIZE}). */
  batchSize?: number;
  /** Test-only passthrough to force the in-process backend. */
  forceInProcess?: boolean;
}

// Server-generated ids only ever use this charset. We interpolate the
// conversation id (never message content) into the SQL script, so reject
// anything outside it as a defense-in-depth guard against a malformed id
// breaking out of the literal.
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function assertSafeId(id: string): void {
  if (!SAFE_ID.test(id)) {
    throw new Error(
      `fork message-delete: unsafe id literal: ${JSON.stringify(id)}`,
    );
  }
}

/**
 * Build the SQL script for one delete batch: enable cascading deletes, remove
 * up to `batchSize` of the conversation's remaining message rows, and print the
 * direct-delete count via `SELECT changes()` so the caller can tell when the
 * conversation is drained. `changes()` counts only the rows deleted from
 * `messages` (not cascade/trigger rows), so it strictly decreases the remaining
 * count and is a sound loop terminator. Exported for unit testing the generated
 * SQL without spawning a subprocess.
 */
export function buildForkDeleteBatchScript(
  conversationId: string,
  batchSize: number,
): string {
  assertSafeId(conversationId);
  const limit = Math.max(1, batchSize);
  return `PRAGMA foreign_keys=ON;
DELETE FROM messages WHERE id IN (
  SELECT id FROM messages WHERE conversation_id = '${conversationId}' LIMIT ${limit}
);
SELECT changes();`;
}

/**
 * Delete a conversation's message rows off the event loop, in lock-friendly
 * batches. Each batch runs as its own subprocess call with a brief yield in
 * between (see {@link DEFAULT_FORK_DELETE_INTER_BATCH_DELAY_MS}) so foreground
 * writers reliably acquire the write lock between batches instead of losing
 * every race to the delete's greedy lock re-acquisition. Loops until a batch
 * deletes fewer rows than the batch size (the conversation is drained), and
 * resolves once every batch has committed — or returns the failing batch's
 * `ok: false` result on subprocess failure, leaving any already-deleted rows
 * gone (the caller's GC is best-effort and an orphan sweep is the backstop).
 *
 * Only the message rows (and their FK cascades) are removed; the caller is
 * responsible for the remaining non-cascading rows and the conversation row.
 */
export async function deleteForkMessagesViaSubprocess(
  options: DeleteForkMessagesOptions,
): Promise<AsyncSqliteResult> {
  const batchSize = Math.max(
    1,
    options.batchSize ?? DEFAULT_FORK_DELETE_BATCH_SIZE,
  );
  const runOptions = options.forceInProcess
    ? { forceBackend: "in-process-blocking" as const }
    : {};

  let totalElapsedMs = 0;
  let backend: AsyncSqliteBackend = "in-process-blocking";

  // Loop until a batch deletes fewer rows than requested — that batch drained
  // the remaining messages, so there is nothing left to delete. Each DELETE
  // strictly shrinks the row set, so the loop always terminates.
  for (;;) {
    const sql = buildForkDeleteBatchScript(options.conversationId, batchSize);
    const result = await runAsyncSqlite(
      sql,
      `fork-message-delete:delete-batch:${options.conversationId}`,
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
    await sleep(DEFAULT_FORK_DELETE_INTER_BATCH_DELAY_MS);
  }

  return { ok: true, backend, error: null, elapsedMs: totalElapsedMs };
}
