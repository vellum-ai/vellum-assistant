/**
 * Cross-process snapshot mutex.
 *
 * The backup worker's in-process `snapshotInProgress` flag only protects one
 * process from racing itself. A CLI `vellum backup create` run against a live
 * daemon has its own independent copy of the flag, so both processes could
 * drive the pipeline concurrently: two WAL checkpoints against the live DB,
 * two renames into the same `backup-YYYYMMDD-HHMMSS.vbundle` path (the second
 * silently clobbering the first), and two retention-pruner passes racing.
 *
 * This module provides a small cross-process lock backed by an atomic
 * `O_CREAT | O_EXCL` file create under `~/.vellum/backups/.snapshot.lock`.
 * The in-process flag is kept as a fast path; this lock is the source of
 * truth whenever two processes could collide.
 *
 * The implementation mirrors the pattern in `daemon/daemon-control.ts`'s
 * startup lock, with two refinements:
 *   1. The lock file contains the holder's PID so we can detect stale locks
 *      by probing liveness with `kill(pid, 0)` rather than a fixed timeout.
 *   2. Acquisition returns a release function so callers can wire it into
 *      a `try/finally` without plumbing a separate release import.
 */

import {
  closeSync,
  constants as fsConstants,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { kill } from "node:process";

import { getLogger } from "../util/logger.js";
import { getLocalBackupsDir } from "./paths.js";

const log = getLogger("snapshot-lock");

/**
 * Returns the canonical path to the snapshot lock file. The lock lives one
 * level above the local backups directory so it stays in place even when the
 * backup pool is wiped or rotated — e.g. at `~/.vellum/backups/.snapshot.lock`.
 *
 * Placing it one level up (rather than inside the `local/` subdir) also
 * guarantees that pruning never touches the lock file and that the lock
 * survives custom `localDirectory` overrides, since we always use the default
 * parent directory for cross-process coordination.
 */
export function getSnapshotLockPath(): string {
  return join(dirname(getLocalBackupsDir()), ".snapshot.lock");
}

/**
 * Check whether a PID refers to a live process. Uses `kill(pid, 0)`, which
 * does not send any signal — it just probes for existence and permission.
 *
 * Returns `false` for obviously invalid PIDs (<= 0) and for any error that
 * indicates the process is gone. Returns `true` for ESRCH-negative results
 * (meaning a process exists) and for EPERM (process exists but is owned by
 * another user — still a live process, still should not be taken over).
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the PID exists but we cannot signal it — treat as alive so
    // we don't accidentally take over another user's lock.
    if (code === "EPERM") return true;
    return false;
  }
}

/**
 * Try to atomically create the lock file with mode `0o600` and the current
 * PID as its contents. Returns `true` on success, `false` if the file
 * already exists (EEXIST), and rethrows any other error.
 */
function tryAtomicCreateLock(lockPath: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(
      lockPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    // Payload: `<pid> <timestamp>` so future callers can diagnose stale locks
    // and so humans inspecting the file can tell how long it has been held.
    const payload = `${process.pid} ${Date.now()}\n`;
    writeSync(fd, payload);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    throw err;
  } finally {
    if (fd != null) {
      try {
        closeSync(fd);
      } catch {
        // best-effort
      }
    }
  }
}

/**
 * Parse the lock file and extract the holder PID. Returns `null` if the file
 * is missing, empty, or does not contain a valid positive integer.
 */
function readLockHolderPid(lockPath: string): number | null {
  try {
    const raw = readFileSync(lockPath, "utf-8").trim();
    if (raw.length === 0) return null;
    // The payload is `<pid> <timestamp>`, but be lenient about formats: any
    // leading positive integer is treated as the PID.
    const match = /^\d+/.exec(raw);
    if (!match) return null;
    const pid = Number.parseInt(match[0], 10);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
}

/**
 * Attempt to acquire the cross-process snapshot lock.
 *
 * On success, returns an idempotent release function that unlinks the lock
 * file. Callers must invoke it in a `finally` block.
 *
 * On conflict with a live holder, throws an error whose message STARTS WITH
 * "snapshot in progress" so existing consumers that match on that prefix
 * (HTTP 409 mapping, CLI error output) continue to work without change.
 *
 * Stale lock handling: if the holder PID is dead (or unparseable), the lock
 * file is removed and acquisition is retried exactly once. We do not loop
 * indefinitely — a second EEXIST after stale cleanup means a legitimate
 * concurrent caller raced us into the newly freed slot, and we report the
 * conflict rather than sit-spinning.
 *
 * The lock directory is created on demand so first-run scenarios (no
 * `~/.vellum/backups` yet) work without a separate bootstrap step.
 */
export async function acquireSnapshotLock(
  lockPath: string,
): Promise<() => Promise<void>> {
  // Ensure the parent directory exists. `mkdirSync({ recursive: true })` is
  // idempotent — it will not fail if the directory already exists.
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });

  const tryAcquire = (): boolean => tryAtomicCreateLock(lockPath);

  if (tryAcquire()) {
    return makeRelease(lockPath);
  }

  // Lock already exists — probe the holder. If it's a dead PID or the file
  // is unreadable, take it over and try once more.
  const holderPid = readLockHolderPid(lockPath);
  if (holderPid != null && isProcessAlive(holderPid)) {
    throw new Error(
      `snapshot in progress (locked by pid ${holderPid})`,
    );
  }

  // Stale lock — the holder PID is dead or the file is corrupt. Remove it
  // and retry once. Any error on unlink (e.g. another process raced us to
  // clean it up) is ignored; the retry will discover the real state.
  log.info(
    { lockPath, holderPid },
    "Taking over stale snapshot lock",
  );
  try {
    unlinkSync(lockPath);
  } catch {
    // best-effort
  }

  if (tryAcquire()) {
    return makeRelease(lockPath);
  }

  // Someone legitimately raced us into the cleaned slot. Report as a
  // conflict so the caller can retry.
  const racePid = readLockHolderPid(lockPath);
  if (racePid != null) {
    throw new Error(
      `snapshot in progress (locked by pid ${racePid})`,
    );
  }
  throw new Error("snapshot in progress (lock contended)");
}

/**
 * Build an idempotent release function for an acquired lock file. Calling
 * the returned function twice is safe — the second unlink catches ENOENT
 * and returns without error.
 */
function makeRelease(lockPath: string): () => Promise<void> {
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      unlinkSync(lockPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        log.warn(
          { err, lockPath },
          "Failed to release snapshot lock (best-effort)",
        );
      }
    }
  };
}
