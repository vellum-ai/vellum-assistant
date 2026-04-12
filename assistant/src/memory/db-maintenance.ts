import { statSync } from "node:fs";

import { getLogger } from "../util/logger.js";
import { getDbPath } from "../util/platform.js";
import { getMemoryCheckpoint, setMemoryCheckpoint } from "./checkpoints.js";
import { getSqlite } from "./db-connection.js";

const log = getLogger("db-maintenance");

const DB_MAINTENANCE_CHECKPOINT_KEY = "db_maintenance:last_run";
const DB_MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface DbStats {
  pageSizeBytes: number;
  pageCount: number;
  freelistCount: number;
  fileSizeBytes: number | null;
}

function getDbStats(): DbStats {
  const sqlite = getSqlite();
  const pageSizeBytes = (
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
  return { pageSizeBytes, pageCount, freelistCount, fileSizeBytes };
}

export function runDbMaintenance(): void {
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

  try {
    getSqlite().exec("VACUUM");
  } catch (err) {
    log.warn({ err }, "VACUUM failed (non-fatal)");
    try {
      getSqlite().exec("PRAGMA optimize");
    } catch (optErr) {
      log.warn({ err: optErr }, "PRAGMA optimize failed (non-fatal)");
    }
    return;
  }

  try {
    getSqlite().exec("PRAGMA optimize");
  } catch (err) {
    log.warn({ err }, "PRAGMA optimize failed (non-fatal)");
  }

  const after = getDbStats();
  const reclaimedPages = before.pageCount - after.pageCount;
  const reclaimedBytes =
    before.fileSizeBytes != null && after.fileSizeBytes != null
      ? before.fileSizeBytes - after.fileSizeBytes
      : null;

  log.info(
    {
      beforePageCount: before.pageCount,
      afterPageCount: after.pageCount,
      reclaimedPages,
      reclaimedBytes,
      afterFileSizeBytes: after.fileSizeBytes,
    },
    "Database maintenance complete",
  );
}

export function maybeRunDbMaintenance(nowMs = Date.now()): void {
  const lastRun = parseInt(
    getMemoryCheckpoint(DB_MAINTENANCE_CHECKPOINT_KEY) ?? "0",
    10,
  );
  if (nowMs - lastRun < DB_MAINTENANCE_INTERVAL_MS) return;

  try {
    runDbMaintenance();
  } catch (err) {
    log.error({ err }, "Database maintenance failed unexpectedly");
  }
  // Always set checkpoint — even on failure — to avoid retry-hammering every tick.
  setMemoryCheckpoint(DB_MAINTENANCE_CHECKPOINT_KEY, String(nowMs));
}
