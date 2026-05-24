import { statSync } from "node:fs";

import { getLogger } from "../util/logger.js";
import { getDbPath } from "../util/platform.js";
import { getMemoryCheckpoint, setMemoryCheckpoint } from "./checkpoints.js";
import { runAsyncSqlite } from "./db-async-query.js";
import { getSqlite } from "./db-connection.js";

const log = getLogger("db-maintenance");

const DB_MAINTENANCE_CHECKPOINT_KEY = "db_maintenance:last_run";
const DB_MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

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

  // VACUUM is the long-running one — minutes on a multi-GB DB. PRAGMA
  // optimize is fast but routed through the same async path for
  // consistency and to keep both off the main thread when the CLI
  // backend is available.
  const vacuumResult = await runAsyncSqlite("VACUUM");
  if (!vacuumResult.ok) {
    log.warn(
      { error: vacuumResult.error, backend: vacuumResult.backend },
      "VACUUM failed (non-fatal)",
    );
  }

  const optimizeResult = await runAsyncSqlite("PRAGMA optimize");
  if (!optimizeResult.ok) {
    log.warn(
      { error: optimizeResult.error, backend: optimizeResult.backend },
      "PRAGMA optimize failed (non-fatal)",
    );
  }

  const after = getDbStats();
  const reclaimedPages = before.pageCount - after.pageCount;
  const reclaimedBytes =
    before.fileSizeBytes != null && after.fileSizeBytes != null
      ? before.fileSizeBytes - after.fileSizeBytes
      : null;

  log.info(
    {
      backend: vacuumResult.backend,
      vacuumOk: vacuumResult.ok,
      optimizeOk: optimizeResult.ok,
      vacuumElapsedMs: vacuumResult.elapsedMs,
      optimizeElapsedMs: optimizeResult.elapsedMs,
      beforePageCount: before.pageCount,
      afterPageCount: after.pageCount,
      reclaimedPages,
      beforeFileSizeBytes: before.fileSizeBytes,
      afterFileSizeBytes: after.fileSizeBytes,
      reclaimedBytes,
    },
    "Database maintenance complete",
  );
}

export async function maybeRunDbMaintenance(nowMs = Date.now()): Promise<void> {
  const lastRun = parseInt(
    getMemoryCheckpoint(DB_MAINTENANCE_CHECKPOINT_KEY) ?? "0",
    10,
  );
  if (nowMs - lastRun < DB_MAINTENANCE_INTERVAL_MS) return;

  try {
    await runDbMaintenance();
  } catch (err) {
    log.error({ err }, "Database maintenance failed unexpectedly");
  }
  // Always set checkpoint — even on failure — to avoid retry-hammering every tick.
  setMemoryCheckpoint(DB_MAINTENANCE_CHECKPOINT_KEY, String(nowMs));
}
