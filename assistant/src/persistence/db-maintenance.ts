import { statSync } from "node:fs";

import { getConfig } from "../config/loader.js";
import { getLogger } from "../util/logger.js";
import { getDbPath } from "../util/platform.js";
import { pruneRuns } from "../workflows/journal-store.js";
import { getMemoryCheckpoint, setMemoryCheckpoint } from "./checkpoints.js";
import { getLastInteractiveUserMessageTimestamp } from "./conversation-crud.js";
import { runAsyncSqlite } from "./db-async-query.js";
import { getSqlite } from "./db-connection.js";

const log = getLogger("db-maintenance");

const DB_MAINTENANCE_CHECKPOINT_KEY = "db_maintenance:last_run";
const DB_PASSIVE_CHECKPOINT_KEY = "db_maintenance:last_passive_checkpoint";

/**
 * Cadence for the ungated PASSIVE WAL checkpoint. Frequent enough that the
 * WAL backlog stays near zero on an always-active instance (so the per-commit
 * autocheckpoints every writer runs stay cheap), infrequent enough that the
 * subprocess spawn is noise.
 */
export const PASSIVE_CHECKPOINT_INTERVAL_MS = 15 * 60 * 1000;

interface DbStats {
  pageSize: number;
  pageCount: number;
  freelistCount: number;
  fileSizeBytes: number | null;
}

function getDbStats(): DbStats {
  const sqlite = getSqlite();
  const pageSize = (
    sqlite.query("PRAGMA page_size").get() as { page_size: number }
  ).page_size;
  const pageCount = (
    sqlite.query("PRAGMA page_count").get() as { page_count: number }
  ).page_count;
  const freelistCount = (
    sqlite.query("PRAGMA freelist_count").get() as { freelist_count: number }
  ).freelist_count;
  let fileSizeBytes: number | null = null;
  try {
    fileSizeBytes = statSync(getDbPath()).size;
  } catch {
    /* non-fatal */
  }
  return { pageSize, pageCount, freelistCount, fileSizeBytes };
}

async function runDbMaintenance(): Promise<void> {
  const before = getDbStats();
  const freelistPct =
    before.pageCount > 0
      ? ((before.freelistCount / before.pageCount) * 100).toFixed(1)
      : "0";

  log.info(
    {
      pageCount: before.pageCount,
      freelistCount: before.freelistCount,
      freelistPct,
      fileSizeBytes: before.fileSizeBytes,
    },
    "Starting database maintenance",
  );

  // Prune finished workflow runs (and their journals) past the retention
  // window. This is a fast bounded DELETE on the small workflow tables, so it
  // runs on the main connection (`rawRun`). SQLite reuses the pages it frees
  // for later writes — we deliberately do not VACUUM to hand them back to the
  // OS (see the WAL note below).
  try {
    const deletedRuns = pruneRuns(getConfig().workflows.journalRetentionDays);
    if (deletedRuns > 0) {
      log.info({ deletedRuns }, "Pruned expired workflow runs");
    }
  } catch (err) {
    log.warn({ err }, "Workflow run pruning failed (non-fatal)");
  }

  // Refresh the query planner's statistics. PRAGMA optimize is cheap; it is
  // routed through the async path for consistency and to keep it off the main
  // thread when the sqlite3 CLI backend is available.
  const optimizeResult = await runAsyncSqlite(
    "PRAGMA optimize",
    "db-maintenance:optimize",
  );
  if (!optimizeResult.ok) {
    log.warn(
      { error: optimizeResult.error, backend: optimizeResult.backend },
      "PRAGMA optimize failed (non-fatal)",
    );
  }

  // Truncate the WAL so it doesn't sit at its high-water mark. We intentionally
  // do NOT run a full VACUUM: in WAL mode VACUUM rewrites the whole database
  // through the WAL, inflating it to ~the database size and needing up to 2x the
  // DB size in free disk to finish. SQLite already reuses freed pages for new
  // writes, so eager space return isn't worth that cost on a multi-GB database.
  //
  // The checkpoint goes through the async path (sqlite3 subprocess when one is
  // available) for the same reason VACUUM/optimize do: a synchronous
  // wal_checkpoint(TRUNCATE) on the shared connection blocks the event loop
  // while it checkpoints frames and waits out readers — the health/IPC stall
  // runAsyncSqlite exists to avoid. A checkpoint from a separate connection
  // still truncates the shared WAL; if a reader holds it back it's a
  // best-effort no-op and the next maintenance pass retries.
  const checkpointResult = await runAsyncSqlite(
    "PRAGMA wal_checkpoint(TRUNCATE)",
    "db-maintenance:wal-checkpoint-truncate",
  );
  if (!checkpointResult.ok) {
    log.warn(
      { error: checkpointResult.error, backend: checkpointResult.backend },
      "WAL checkpoint failed (non-fatal)",
    );
  }

  const after = getDbStats();
  log.info(
    {
      optimizeOk: optimizeResult.ok,
      optimizeBackend: optimizeResult.backend,
      optimizeElapsedMs: optimizeResult.elapsedMs,
      checkpointOk: checkpointResult.ok,
      checkpointBackend: checkpointResult.backend,
      checkpointResult: checkpointResult.stdout?.trim(),
      checkpointElapsedMs: checkpointResult.elapsedMs,
      pageCount: after.pageCount,
      freelistCount: after.freelistCount,
      fileSizeBytes: after.fileSizeBytes,
    },
    "Database maintenance complete",
  );
}

export async function maybeRunDbMaintenance(nowMs = Date.now()): Promise<void> {
  const { intervalMs, quietPeriodMs } = getConfig().memory.maintenance;

  const lastRun = parseInt(
    getMemoryCheckpoint(DB_MAINTENANCE_CHECKPOINT_KEY) ?? "0",
    10,
  );
  if (nowMs - lastRun < intervalMs) {
    return;
  }

  // Maintenance still takes brief write locks (PRAGMA optimize and the
  // truncating WAL checkpoint), so defer it until the user has been quiet for
  // `quietPeriodMs` and those locks never land mid-conversation. "Quiet"
  // means HUMAN quiet — the newest user-role message in an interactive
  // conversation. Background machinery writes user-role rows of its own
  // (retrospective instructions, scheduled/heartbeat wake hints) inside
  // background/scheduled conversations; counting those would keep an
  // always-on install permanently "active" and starve this pass forever. The
  // checkpoint below is only written once maintenance actually runs, so a
  // deferred run is simply retried on a later (still-idle) worker tick.
  if (quietPeriodMs > 0) {
    const lastUserMessageAt = getLastInteractiveUserMessageTimestamp();
    if (lastUserMessageAt > 0 && nowMs - lastUserMessageAt < quietPeriodMs) {
      return;
    }
  }

  try {
    await runDbMaintenance();
  } catch (err) {
    log.error({ err }, "Database maintenance failed unexpectedly");
  }
  // Always set checkpoint — even on failure — to avoid retry-hammering every tick.
  setMemoryCheckpoint(DB_MAINTENANCE_CHECKPOINT_KEY, String(nowMs));
}

/**
 * Ungated PASSIVE WAL checkpoint on a short cadence (see
 * {@link PASSIVE_CHECKPOINT_INTERVAL_MS}).
 *
 * PASSIVE never blocks anyone: it gives up instantly if another checkpointer
 * holds the checkpointer lock and backfills only up to the oldest live
 * reader's mark — so unlike the truncating maintenance checkpoint it needs no
 * quiet-period gate and is safe mid-conversation. Running it continuously
 * keeps the WAL backlog near zero on always-active instances, which keeps
 * every writer's per-commit autocheckpoint cheap (a large standing backlog
 * otherwise amortizes multi-second backfill work into commits while they hold
 * the write lock).
 *
 * The `busy|log|checkpointed` triple is logged like the truncate path's: a
 * persistently large gap between `log` and `checkpointed` frames means a
 * pinned reader is starving checkpoints — the diagnostic that matters when a
 * WAL balloons anyway.
 */
export async function maybeRunPassiveWalCheckpoint(
  nowMs = Date.now(),
): Promise<void> {
  const lastRun = parseInt(
    getMemoryCheckpoint(DB_PASSIVE_CHECKPOINT_KEY) ?? "0",
    10,
  );
  if (nowMs - lastRun < PASSIVE_CHECKPOINT_INTERVAL_MS) {
    return;
  }

  try {
    const result = await runAsyncSqlite(
      "PRAGMA wal_checkpoint(PASSIVE)",
      "db-maintenance:wal-checkpoint-passive",
    );
    if (result.ok) {
      log.info(
        {
          backend: result.backend,
          checkpointResult: result.stdout?.trim(),
          elapsedMs: result.elapsedMs,
        },
        "Passive WAL checkpoint complete",
      );
    } else {
      log.warn(
        { error: result.error, backend: result.backend },
        "Passive WAL checkpoint failed (non-fatal)",
      );
    }
  } catch (err) {
    log.warn({ err }, "Passive WAL checkpoint threw (non-fatal)");
  }
  // Always set checkpoint — even on failure — to avoid retry-hammering every tick.
  setMemoryCheckpoint(DB_PASSIVE_CHECKPOINT_KEY, String(nowMs));
}
