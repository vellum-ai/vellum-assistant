// ---------------------------------------------------------------------------
// Bulk-write gate — process-wide FIFO serialization of bulk main-DB writers.
// ---------------------------------------------------------------------------
//
// The batched bulk writers (fork message-copy, conversation-row batch delete)
// each hold the main database's write lock only briefly per batch — but SQLite
// has a single writer, so two bulk streams running concurrently gain no
// throughput. They only convoy: every batch of each stream contends with the
// other's (waiting up to `busy_timeout`), and the inter-batch yield each
// stream inserts for foreground fairness is consumed by the sibling stream
// instead of the live user turn it was meant for. Concurrent streams are
// reachable because the memory jobs worker groups jobs by
// `(type, conversationId)` — retrospectives for two different conversations
// run in parallel.
//
// This gate serializes those streams within the process: one bulk writer runs
// at a time, the rest queue FIFO, and the write lock (plus the yields) go back
// to foreground writers. Waiters are bounded by the jobs worker's lane
// concurrency, and the durable jobs queue upstream coalesces to one pending
// row per conversation, so the gate cannot accumulate an unbounded backlog.
//
// Scope and discipline:
//   - Per-process. The daemon and each worker process have their own gate;
//     bulk writers live almost entirely in the memory worker, so cross-process
//     overlap is rare.
//   - Main DB only. Dedicated files (e.g. the logs DB) have their own write
//     locks and must not queue behind main-DB streams.
//   - Callers wrap only their batch loop — never an LLM call, a wake, or an
//     open transaction — so the worst-case hold is one bulk pass, itself
//     bounded by {@link BULK_BATCH_TIMEOUT_MS} per batch.

import { getLogger } from "../util/logger.js";
import { Mutex } from "../util/mutex.js";

const log = getLogger("bulk-write-gate");

/**
 * Per-batch subprocess timeout for gated bulk writers. `runAsyncSqlite`'s
 * default cap (1 h) is sized for legitimately long single statements like
 * `VACUUM`; a gated bulk batch is a sub-second write, so a batch anywhere near
 * this bound is wedged (stale lock, dead disk) and must fail rather than hold
 * the gate — and every queued bulk writer behind it — for the full default.
 */
export const BULK_BATCH_TIMEOUT_MS = 5 * 60 * 1000;

/** Gate waits longer than this are logged — the convoy-formation signal. */
const CONTENTION_LOG_THRESHOLD_MS = 1000;

const gate = new Mutex();
let heldBy: string | null = null;

/** Label of the bulk writer currently holding the gate, or null when free. */
export function bulkWriteGateHolder(): string | null {
  return heldBy;
}

/**
 * Run `fn` as the sole bulk main-DB writer in this process. Callers queue
 * FIFO; the gate is released when `fn` settles (resolve or reject), so a
 * throwing writer never wedges the queue.
 */
export async function withBulkWriteGate<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const waitStartMs = Date.now();
  return await gate.withLock(async () => {
    const waitedMs = Date.now() - waitStartMs;
    if (waitedMs >= CONTENTION_LOG_THRESHOLD_MS) {
      log.info(
        { label, waitedMs },
        "bulk-write gate: waited for prior bulk writers",
      );
    }
    heldBy = label;
    try {
      return await fn();
    } finally {
      heldBy = null;
    }
  });
}
