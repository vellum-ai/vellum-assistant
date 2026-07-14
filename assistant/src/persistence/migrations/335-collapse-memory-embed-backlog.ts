import { randomUUID } from "node:crypto";

import { getConfig } from "../../config/loader.js";
import { getLogger } from "../../util/logger.js";
import { getMemoryDbPath } from "../../util/memory-db-path.js";
import { parseChangesFromStdout, runAsyncSqlite } from "../db-async-query.js";
import { type DrizzleDb, getMemorySqlite } from "../db-connection.js";

const log = getLogger("memory-db");

/**
 * Batch size for the pending `embed_concept_page` purge. Matches the
 * relocation drain batch: large enough for throughput, small enough that the
 * write lock is held only briefly per statement.
 */
const PURGE_BATCH = 10_000;

/**
 * `true` unless `memory.enabled` or `memory.v2.enabled` is explicitly
 * `false`. Missing/unloadable config falls through to the schema defaults
 * (enabled) — mirrors `isMemoryEnabled` in the jobs store and the gating of
 * workspace migration 085.
 */
function memoryV2ReembedAllowed(): boolean {
  try {
    const config = getConfig();
    if (config.memory?.enabled === false) {
      return false;
    }
    if (config.memory?.v2?.enabled === false) {
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

/**
 * Collapse duplicate pending memory-v2 maintenance jobs left behind by
 * unguarded enqueues.
 *
 * `memory_v2_reembed` (payload `{}`, lists every concept page at execution
 * time) and its per-page `embed_concept_page` fan-out (payload `{slug}`, page
 * read from disk at execution time) are enqueued with pending-row coalescing,
 * so at most one pending row exists per reembed / per slug. A queue populated
 * before that coalescing can hold millions of duplicates — each pending
 * reembed fans out one embed per page as it drains, so the backlog grows even
 * after the enqueue storm stops. All duplicates describe identical work: one
 * full reembed pass regenerates exactly the deduplicated queue.
 *
 * Sequence (each step idempotent; a crash resumes safely on the next boot):
 *   1. When the memory-v2 gates allow it and pending `embed_concept_page`
 *      rows exist with no pending/running `memory_v2_reembed`, insert one
 *      replacement reembed. The insert happens BEFORE any delete so a crash
 *      mid-purge can never leave deleted embeds with no reembed to
 *      regenerate them. When a gate is explicitly off, pending reembeds are
 *      deleted instead (runs against the user's intent — workspace migration
 *      085 parity) and nothing is inserted.
 *   2. Collapse pending `memory_v2_reembed` and pending `memory_v3_maintain`
 *      to their earliest row each. `memory_v3_maintain` is never inserted —
 *      its handler no-ops while v3 is off and the scheduler self-heals.
 *   3. Delete ALL pending `embed_concept_page` rows in bounded batches off
 *      the event loop — the surviving/inserted reembed re-fans one embed per
 *      existing page. Accepted edge: a pending embed for a since-deleted page
 *      carried a Qdrant point deletion that a page-listing reembed will not
 *      regenerate; the startup embedding reconcile covers the stale point.
 *   4. Truncate the memory DB's WAL (best-effort).
 *
 * Only `pending` rows of exactly these three types are touched. Running rows
 * survive (their claimer owns them), as do all other job types — notably
 * `embed_segment`, whose pending rows carry distinct meaningful payloads. A
 * worker left over from before the daemon restarted can re-enqueue a fan-out
 * mid-purge; that residue is bounded by the page count and the coalescing
 * enqueues absorb it.
 *
 * Throws (rather than returning) if the memory database cannot be opened, so
 * the runner records the step as failed and retries it on a later boot. The
 * throw is caught per-step by the runner, so startup is not aborted.
 */
export async function migrateCollapseMemoryEmbedBacklog(
  _database: DrizzleDb,
): Promise<void> {
  const memoryRaw = getMemorySqlite();
  if (!memoryRaw) {
    throw new Error(
      "memory database unavailable — deferring embed-backlog collapse",
    );
  }

  const hasPendingEmbeds =
    memoryRaw
      .query(
        `SELECT 1 FROM memory_jobs WHERE type='embed_concept_page' AND status='pending' LIMIT 1`,
      )
      .get() != null;

  if (memoryV2ReembedAllowed()) {
    if (hasPendingEmbeds) {
      const existingReembed = memoryRaw
        .query(
          `SELECT id FROM memory_jobs WHERE type='memory_v2_reembed' AND status IN ('pending','running') LIMIT 1`,
        )
        .get();
      if (!existingReembed) {
        const now = Date.now();
        memoryRaw
          .query(
            `INSERT INTO memory_jobs
               (id, type, payload, status, attempts, deferrals, run_after, last_error, created_at, updated_at)
             VALUES (?, 'memory_v2_reembed', '{}', 'pending', 0, 0, ?, NULL, ?, ?)`,
          )
          .run(randomUUID(), now, now, now);
      }
    }
    memoryRaw
      .query(
        `DELETE FROM memory_jobs
         WHERE type='memory_v2_reembed' AND status='pending'
           AND rowid != (SELECT MIN(rowid) FROM memory_jobs WHERE type='memory_v2_reembed' AND status='pending')`,
      )
      .run();
  } else {
    memoryRaw
      .query(
        `DELETE FROM memory_jobs WHERE type='memory_v2_reembed' AND status='pending'`,
      )
      .run();
  }

  memoryRaw
    .query(
      `DELETE FROM memory_jobs
       WHERE type='memory_v3_maintain' AND status='pending'
         AND rowid != (SELECT MIN(rowid) FROM memory_jobs WHERE type='memory_v3_maintain' AND status='pending')`,
    )
    .run();

  if (hasPendingEmbeds) {
    const dbPath = getMemoryDbPath();
    let totalPurged = 0;
    for (;;) {
      const res = await runAsyncSqlite(
        `DELETE FROM memory_jobs WHERE rowid IN (` +
          `SELECT rowid FROM memory_jobs WHERE type='embed_concept_page' AND status='pending' LIMIT ${PURGE_BATCH});\n` +
          `SELECT changes();`,
        "embed-backlog-collapse:purge-batch",
        { dbPath },
      );
      if (!res.ok) {
        throw new Error(`embed-backlog purge batch failed: ${res.error}`);
      }
      const purged = parseChangesFromStdout(res.stdout);
      if (purged === 0) {
        break;
      }
      totalPurged += purged;
      log.info(
        { purged, totalPurged },
        "embed-backlog collapse: purge progressed",
      );
    }

    const finalizeRes = await runAsyncSqlite(
      `PRAGMA wal_checkpoint(TRUNCATE);`,
      "embed-backlog-collapse:wal-truncate",
      { dbPath },
    );
    if (!finalizeRes.ok) {
      log.warn(
        { error: finalizeRes.error },
        "embed-backlog collapse: WAL truncate failed (best-effort)",
      );
    }
    log.info({ totalPurged }, "embed-backlog collapse: complete");
  }
}
