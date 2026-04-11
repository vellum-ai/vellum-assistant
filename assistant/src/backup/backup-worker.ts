/**
 * Periodic backup worker.
 *
 * Drives the backup pipeline on a 5-minute tick interval. On each tick it
 * checks whether `config.enabled` is true and whether enough time has passed
 * since the last successful run; if so, it builds a workspace vbundle,
 * writes it to the local backup directory, mirrors it to every configured
 * offsite destination, applies retention to each pool, and records the run
 * timestamp in the memory checkpoint store.
 *
 * The public surface is intentionally split into three layers:
 *
 * - `startBackupWorker` — installs the `setInterval` and returns a handle
 *   with `stop()` and `runOnce()`. Must never throw during startup (daemon
 *   startup philosophy); any failure during setup falls back to a no-op
 *   handle and logs the error.
 * - `runBackupTick` — the pure tick body. Gates on `enabled` + interval +
 *   mutex, then delegates to `performBackup`. Propagates errors so callers
 *   (tests, the interval wrapper) can observe failures.
 * - `createSnapshotNow` — manual-trigger variant. Bypasses the enabled and
 *   interval checks, but still honors the concurrency mutex (so a manual
 *   trigger will reject with "snapshot in progress" if one is in flight).
 *
 * Everything that touches real daemon state (DB, workspace, filesystem) is
 * injected through the `BackupDeps` shape so tests can drive the whole
 * surface against temp directories with tiny fake bundles.
 */

import { join } from "node:path";
import { Database } from "bun:sqlite";

import { getConfig } from "../config/loader.js";
import type { BackupConfig } from "../config/schema.js";
import {
  getMemoryCheckpoint as realGetMemoryCheckpoint,
  setMemoryCheckpoint as realSetMemoryCheckpoint,
} from "../memory/checkpoints.js";
import type { StreamExportVBundleResult } from "../runtime/migrations/vbundle-builder.js";
import { streamExportVBundle as realStreamExportVBundle } from "../runtime/migrations/vbundle-builder.js";
import { getLogger } from "../util/logger.js";
import {
  getDbPath,
  getProtectedDir,
  getWorkspaceDir,
  getWorkspaceHooksDir,
} from "../util/platform.js";
import { ensureBackupKey as realEnsureBackupKey } from "./backup-key.js";
import type { SnapshotEntry } from "./list-snapshots.js";
import {
  pruneLocalSnapshots,
  writeLocalSnapshot,
} from "./local-writer.js";
import type { OffsiteWriteResult } from "./offsite-writer.js";
import {
  pruneOffsiteSnapshotsInAll,
  writeOffsiteSnapshotToAll,
} from "./offsite-writer.js";
import {
  getBackupKeyPath,
  getLocalBackupsDir,
  resolveOffsiteDestinations,
} from "./paths.js";

const log = getLogger("backup-worker");

/** Memory checkpoint key for the last successful backup run timestamp. */
const LAST_RUN_CHECKPOINT_KEY = "backup:last_run_at";

/** Default tick interval — fires every 5 minutes, gated by interval check. */
const TICK_INTERVAL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Result of a single backup run. `offsite` is an array with one entry per
 * destination so callers can inspect per-destination success / skip / error
 * status — a single missing offsite volume does not poison the whole run.
 */
export interface BackupRunResult {
  local: SnapshotEntry;
  offsite: OffsiteWriteResult[];
  durationMs: number;
}

/**
 * Opaque handle returned by `startBackupWorker`. Callers drive the worker
 * exclusively through this handle; the underlying timer and mutex state are
 * module-scoped implementation details.
 */
export interface BackupWorkerHandle {
  stop(): void;
  runOnce(): Promise<BackupRunResult | null>;
}

/**
 * Dependency injection bag for `runBackupTick` / `createSnapshotNow`.
 *
 * In production the defaults wire up the real DB, workspace, and memory
 * checkpoint store. Tests inject fakes so they can drive the worker
 * against temp directories with in-memory checkpoint state.
 */
export interface BackupDeps {
  streamExportVBundle?: (
    options: Parameters<typeof realStreamExportVBundle>[0],
  ) => Promise<StreamExportVBundleResult>;
  getMemoryCheckpoint?: (key: string) => string | null;
  setMemoryCheckpoint?: (key: string, value: string) => void;
  ensureBackupKey?: (path: string) => Promise<Buffer>;
  /** Override for the workspace directory (tests). */
  workspaceDir?: string;
  /** Override for the local backup directory (tests). */
  localDir?: string;
  /** Override for the trust.json path (tests). */
  trustPath?: string;
  /** Override for the hooks directory (tests). */
  hooksDir?: string;
  /** Override for the backup key file path (tests). */
  backupKeyPath?: string;
}

// ---------------------------------------------------------------------------
// Concurrency mutex (module-scoped)
// ---------------------------------------------------------------------------

/**
 * In-memory mutex flag. Both the scheduled tick and the manual trigger share
 * this flag so that:
 * - A scheduled tick that fires while a manual run is in flight skips silently.
 * - A manual run that starts while a scheduled tick is running throws so the
 *   user can decide how to react (retry, wait, surface the conflict).
 *
 * The mutex is deliberately module-scoped rather than tied to the handle
 * returned by `startBackupWorker` — the daemon may start the worker once at
 * boot and also call `createSnapshotNow` from other code paths, and both must
 * see the same concurrency state.
 */
let snapshotInProgress = false;

// ---------------------------------------------------------------------------
// Core pipeline body
// ---------------------------------------------------------------------------

/**
 * The shared body that both `runBackupTick` and `createSnapshotNow` call
 * after their gating checks pass. Does not touch the mutex — callers are
 * responsible for acquiring it.
 *
 * Pipeline:
 *   1. Resolve offsite destinations (iCloud default if config did not
 *      specify an explicit array).
 *   2. Load the backup key only if at least one destination needs it.
 *      Plaintext-only setups never touch the key file.
 *   3. Stream the workspace into a temp .vbundle file, passing a WAL
 *      checkpoint callback so the exported DB has every committed row.
 *   4. Move the temp file into the local backup directory (rename).
 *      After this point the temp file no longer exists, so we must not
 *      call the `cleanup()` callback on success.
 *   5. Mirror the local file to every offsite destination (sequential).
 *   6. Apply retention to the local pool and every offsite pool.
 */
async function performBackup(
  config: BackupConfig,
  now: Date,
  deps: BackupDeps,
): Promise<BackupRunResult> {
  const streamExport = deps.streamExportVBundle ?? realStreamExportVBundle;
  const ensureKey = deps.ensureBackupKey ?? realEnsureBackupKey;
  const workspaceDir = deps.workspaceDir ?? getWorkspaceDir();
  const localDir = deps.localDir ?? getLocalBackupsDir(config.localDirectory);
  const trustPath =
    deps.trustPath ?? join(getProtectedDir(), "trust.json");
  const hooksDir = deps.hooksDir ?? getWorkspaceHooksDir();
  const backupKeyPath = deps.backupKeyPath ?? getBackupKeyPath();

  const startTimestamp = Date.now();

  const destinations = config.offsite.enabled
    ? resolveOffsiteDestinations(config.offsite.destinations)
    : [];
  const needsKey = destinations.some((d) => d.encrypt);
  const key: Buffer | null = needsKey ? await ensureKey(backupKeyPath) : null;

  // Build the vbundle into a temp file. Pass a WAL checkpoint callback that
  // mirrors the pattern in `handleMigrationExport`: open a fresh Database
  // handle, run PRAGMA wal_checkpoint(TRUNCATE), close it. Any failure is
  // best-effort — the export still proceeds with whatever is on disk.
  const result = await streamExport({
    workspaceDir,
    trustPath,
    hooksDir,
    source: "backup-worker",
    description: "Automated backup snapshot",
    checkpoint: () => {
      const dbPath = getDbPath();
      try {
        const db = new Database(dbPath);
        try {
          db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        } finally {
          db.close();
        }
      } catch (err) {
        log.warn(
          { err },
          "WAL checkpoint failed — proceeding with backup without checkpoint",
        );
      }
    },
  });

  const { tempPath, cleanup } = result;

  // `writeLocalSnapshot` moves (renames) the temp file to its final
  // location. On success the temp file no longer exists, so we MUST NOT
  // call `cleanup()` afterwards — it would try to unlink a missing path.
  // On failure we still need to unlink the temp file to avoid leaks.
  let localResult: SnapshotEntry;
  try {
    localResult = await writeLocalSnapshot(tempPath, localDir, now);
  } catch (err) {
    try {
      await cleanup();
    } catch {
      // best-effort
    }
    throw err;
  }

  const offsiteResults = await writeOffsiteSnapshotToAll(
    localResult.path,
    destinations,
    key,
    now,
  );

  // Apply retention to both pools. Retention is per-destination so a
  // missing offsite volume doesn't skew the local pool's retention count.
  await pruneLocalSnapshots(localDir, config.retention);
  await pruneOffsiteSnapshotsInAll(destinations, config.retention);

  log.info(
    {
      localPath: localResult.path,
      offsite: offsiteResults.map((r) => ({
        path: r.destination.path,
        status: r.entry ? "ok" : r.skipped ? "skipped" : "error",
        reason: r.skipped ?? r.error,
      })),
    },
    "Backup snapshot complete",
  );

  return {
    local: localResult,
    offsite: offsiteResults,
    durationMs: Date.now() - startTimestamp,
  };
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Pure tick body for the scheduled backup worker. Runs the enabled + interval
 * gates, acquires the mutex, delegates to `performBackup`, and records the
 * last-run timestamp on success. Returns `null` if any gate rejects the run.
 *
 * Errors from `performBackup` propagate — the `setInterval` caller wraps this
 * in a try/catch that logs and swallows, so daemon startup and steady-state
 * ticks never crash the process.
 */
export async function runBackupTick(
  config: BackupConfig,
  now: Date,
  deps: BackupDeps = {},
): Promise<BackupRunResult | null> {
  if (config.enabled !== true) return null;

  const getCheckpoint = deps.getMemoryCheckpoint ?? realGetMemoryCheckpoint;
  const setCheckpoint = deps.setMemoryCheckpoint ?? realSetMemoryCheckpoint;

  const lastRunRaw = getCheckpoint(LAST_RUN_CHECKPOINT_KEY);
  if (lastRunRaw != null) {
    const lastRunMs = Number.parseInt(lastRunRaw, 10);
    if (!Number.isNaN(lastRunMs)) {
      const intervalMs = config.intervalHours * 3600 * 1000;
      if (now.getTime() - lastRunMs < intervalMs) {
        return null;
      }
    }
  }

  // A manual snapshot in flight wins — the scheduled tick silently defers
  // and will reconsider on the next interval.
  if (snapshotInProgress) return null;
  snapshotInProgress = true;
  try {
    const result = await performBackup(config, now, deps);
    setCheckpoint(LAST_RUN_CHECKPOINT_KEY, String(now.getTime()));
    return result;
  } finally {
    snapshotInProgress = false;
  }
}

/**
 * Manual-trigger variant of the backup pipeline. Bypasses the `enabled` and
 * interval checks so users can force a snapshot regardless of schedule, but
 * still honors the concurrency mutex — a second concurrent caller throws
 * with "snapshot in progress".
 *
 * Does NOT update the last-run checkpoint on success: manual snapshots are
 * an escape hatch and should not reset the automatic cadence.
 */
export async function createSnapshotNow(
  config: BackupConfig,
  now: Date,
  deps: BackupDeps = {},
): Promise<BackupRunResult> {
  if (snapshotInProgress) {
    throw new Error("snapshot in progress");
  }
  snapshotInProgress = true;
  try {
    return await performBackup(config, now, deps);
  } finally {
    snapshotInProgress = false;
  }
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/**
 * A no-op handle used when `startBackupWorker` fails to install its timer.
 * Returning a live handle even on failure lets callers follow the normal
 * `.stop()` cleanup path unconditionally.
 */
const NOOP_HANDLE: BackupWorkerHandle = {
  stop: () => {},
  runOnce: async () => null,
};

/**
 * Install the periodic backup worker.
 *
 * Schedules a `setInterval` tick every 5 minutes and returns a handle with
 * `stop()` and `runOnce()`. `runOnce()` invokes the tick body synchronously
 * (bypassing the interval) so callers can drive a backup from code without
 * waiting up to 5 minutes for the next tick.
 *
 * Daemon startup philosophy: this function must never throw. Any unexpected
 * error during setup logs and returns a no-op handle so the caller's startup
 * sequence proceeds unperturbed.
 */
export function startBackupWorker(): BackupWorkerHandle {
  try {
    const timer = setInterval(() => {
      void (async () => {
        try {
          const config = getConfig();
          await runBackupTick(config.backup, new Date());
        } catch (err) {
          log.warn({ err }, "Backup worker tick failed");
        }
      })();
    }, TICK_INTERVAL_MS);

    // Non-blocking: the process may exit even if the timer is still armed.
    (timer as NodeJS.Timeout).unref?.();

    let stopped = false;
    return {
      stop(): void {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
      },
      async runOnce(): Promise<BackupRunResult | null> {
        const config = getConfig();
        return runBackupTick(config.backup, new Date());
      },
    };
  } catch (err) {
    log.warn({ err }, "Failed to start backup worker — continuing without it");
    return NOOP_HANDLE;
  }
}
