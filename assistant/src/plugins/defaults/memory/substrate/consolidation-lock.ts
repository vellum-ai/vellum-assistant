// SUBSTRATE (v2+v3).
/**
 * Memory substrate: the single-process consolidation lock.
 *
 * Serializes bulk writers of the `memory/` files so two overlapping passes
 * can't fight over the same corpus.
 *
 * The lock is a `wx`-created file at `memory/.v2-state/consolidation.lock`
 * containing the holder's PID + timestamp (plus an optional advisory tag), so
 * a crashed run leaves a diagnosable trace. A stale lock is taken over
 * automatically on the next acquire (single-writer per workspace): when the
 * holder's PID is no longer running, or (because the daemon runs as PID 1 in
 * containers and a restarted daemon collides with the dead holder's PID)
 * when the lock is older than {@link STALE_LOCK_TTL_MS}.
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { isProcessAlive } from "../host-utils.js";
import { getLogger } from "../logging.js";

const log = getLogger("memory-v2-consolidate");

/**
 * Hard timeout for the consolidation run. Consolidation reads the buffer,
 * rewrites several files, and re-encodes essentials/threads: on a mature
 * corpus a full pass legitimately runs ~20 minutes under cross-process write
 * contention, so the bound leaves headroom above that while still keeping a
 * stuck run from pinning the worker indefinitely. Matches the default
 * `timeouts.backgroundTurnTimeoutSec` budget for heartbeat/background turns.
 * Overrunning it marks the run failed and skips its follow-up jobs (reembeds,
 * v3 maintenance) even though the agent's file edits land, so the bound must
 * comfortably exceed a healthy run's duration.
 */
export const CONSOLIDATION_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Age past which a lock held by an apparently-live PID is taken over anyway.
 *
 * The PID-liveness probe alone is not sufficient in containers: the daemon
 * runs as PID 1, so after a container restart `isProcessAlive(1)` reports the
 * NEW daemon as alive even though it is not the process that wrote the lock.
 * PID-1 collision means a lock left behind by a crashed/restarted run can
 * never be declared stale by liveness alone, and consolidation wedges
 * permanently (every scheduled run skips with `locked`).
 *
 * A lock older than this TTL is treated as abandoned regardless of PID
 * liveness. The bound is a large multiple of the run's hard timeout: the
 * lock timestamp is written at acquire time and a run can hold the lock for
 * at most `CONSOLIDATION_TIMEOUT_MS`, so a TTL well above that can never fire
 * against a legitimately in-flight run while still recovering a wedged lock
 * within a couple of scheduled passes.
 */
export const STALE_LOCK_TTL_MS = 4 * CONSOLIDATION_TIMEOUT_MS;

/** The consolidation lock's location under a workspace's `memory/` dir. */
export function getConsolidationLockPath(memoryDir: string): string {
  // FROZEN: `memory/.v2-state/` is a persisted workspace path; never rename.
  return join(memoryDir, ".v2-state", "consolidation.lock");
}

/**
 * Atomically create the lock file with `wx` (O_CREAT | O_EXCL) flags. Returns
 * `null` on success, or the current holder string (file contents, typically
 * `pid timestamp`) when the file already exists and the holder is still alive.
 *
 * `holderTag` is an optional advisory suffix appended after the PID and
 * timestamp (payload `<pid> <timestamp> <tag>`) so operators can tell which
 * writer holds the lock; stale classification ignores it.
 *
 * Stale-lock takeover: if the file exists but its holder is stale (PID not
 * running, payload corrupt, or (for the container PID-1 collision) older
 * than the TTL; see {@link holderStaleReason}), unlink the stale file and
 * retry the create exactly once. This recovers automatically from a crashed
 * or restarted daemon that died with the lock held; otherwise every
 * subsequent scheduled consolidation would skip with `locked` indefinitely
 * until an operator manually removed the file.
 *
 * The simple takeover-then-retry is safe here (unlike `snapshot-lock.ts`'s
 * full rename-aside dance) because only the assistant's jobs worker calls
 * this lock, and at most one assistant process runs per workspace at any
 * time. A holder with an unparseable / empty payload is treated as stale:
 * the only writers ever produce a `<pid> <timestamp>` line, so an
 * unparseable file is corruption from a partial write that crashed.
 */
export function tryAcquireLock(
  lockPath: string,
  holderTag?: string,
): string | null {
  // The workspace migration seeds `memory/.v2-state/`, but tests and
  // ad-hoc workspaces may not have it yet. `mkdirSync({ recursive: true })`
  // is idempotent, so the call is cheap when the dir already exists.
  mkdirSync(dirname(lockPath), { recursive: true });

  const firstHolder = tryCreate(lockPath, holderTag);
  if (firstHolder === null) {
    return null;
  }
  const staleReason = holderStaleReason(firstHolder);
  if (staleReason === null) {
    return firstHolder;
  }

  log.info(
    { lockPath, holder: firstHolder, reason: staleReason },
    "consolidation: taking over stale lock",
  );
  try {
    unlinkSync(lockPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      log.warn(
        { err, lockPath },
        "consolidation: failed to unlink stale lock; reporting as locked",
      );
      return firstHolder;
    }
  }
  // After unlink, the next `wx` create should succeed. If a third party
  // raced in and re-acquired (vanishingly unlikely with one writer per
  // workspace), surface their holder string rather than overwriting.
  return tryCreate(lockPath, holderTag);
}

/**
 * Atomically create the lock file. Returns `null` on success, or the holder
 * string read from the file when it already exists (`"unknown"` if the read
 * itself fails). Rethrows any non-EEXIST errno from `openSync`.
 */
function tryCreate(lockPath: string, holderTag?: string): string | null {
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw err;
    }
    try {
      return readFileSync(lockPath, "utf-8").trim() || "unknown";
    } catch {
      return "unknown";
    }
  }
  try {
    const tagSuffix = holderTag === undefined ? "" : ` ${holderTag}`;
    writeSync(fd, `${process.pid} ${Date.now()}${tagSuffix}\n`);
  } catch {
    // best-effort: payload is advisory, the file's existence is the lock
  } finally {
    try {
      closeSync(fd);
    } catch {
      // best-effort
    }
  }
  return null;
}

/**
 * Why a lock holder is considered stale, for diagnosable takeover logs:
 *   - `unparseable`: empty / corrupt payload (partial write from a crash).
 *   - `pid_dead`: the holder's PID is no longer running.
 *   - `expired`: the lock is older than {@link STALE_LOCK_TTL_MS} even though
 *     its PID still appears alive (the PID-1 collision case in containers).
 */
type StaleReason = "unparseable" | "pid_dead" | "expired";

/**
 * Parse a `<pid> <timestamp>` holder payload (see `tryCreate`'s write).
 * Returns `null` when the PID cannot be parsed; a missing/garbled timestamp
 * yields `timestamp: null` so a partial payload still gives us the PID.
 */
function parseHolder(
  holder: string,
): { pid: number; timestamp: number | null } | null {
  const match = /^(\d+)(?:\s+(\d+))?/.exec(holder);
  if (!match) {
    return null;
  }
  const pid = Number.parseInt(match[1], 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    return null;
  }
  const timestamp =
    match[2] !== undefined ? Number.parseInt(match[2], 10) : null;
  return {
    pid,
    timestamp:
      timestamp !== null && Number.isFinite(timestamp) ? timestamp : null,
  };
}

/**
 * Classify a holder string, returning the reason it is stale or `null` when
 * the lock is held by a live process and must be respected.
 *
 * Takeover triggers, in order:
 *   1. Unparseable / empty / `"unknown"` payload → `unparseable`. The only
 *      writer is `tryCreate`, so corruption is a partial write from a crashed
 *      prior holder, not a live writer mid-flush.
 *   2. PID not running → `pid_dead`. The fast path for a crashed daemon (or a
 *      different process now occupying that PID on a normal host).
 *   3. Lock older than {@link STALE_LOCK_TTL_MS} → `expired`. Required because
 *      the daemon runs as PID 1 in containers: after a restart the new daemon
 *      is also PID 1, so the liveness probe alone reports the holder as alive
 *      forever and could never reclaim an abandoned lock. The TTL is far above
 *      the run's hard timeout, so it never fires against an in-flight run.
 */
function holderStaleReason(holder: string): StaleReason | null {
  const parsed = parseHolder(holder);
  if (parsed === null) {
    return "unparseable";
  }
  if (!isProcessAlive(parsed.pid)) {
    return "pid_dead";
  }
  if (
    parsed.timestamp !== null &&
    Date.now() - parsed.timestamp > STALE_LOCK_TTL_MS
  ) {
    return "expired";
  }
  return null;
}

/**
 * Idempotent unlink of the lock file. Called from the caller's `finally`
 * block so a crash in the run path doesn't leave the lock stranded. ENOENT is
 * swallowed
 * because the lock may have been released by an operator or never created
 * (acquire failed before reaching the lock-write step).
 */
export function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return;
    }
    log.warn(
      { err, lockPath },
      "consolidation: failed to release lock (best-effort)",
    );
  }
}
