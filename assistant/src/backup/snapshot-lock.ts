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
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { kill } from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

import { getLogger } from "../util/logger.js";
import { getLocalBackupsDir } from "./paths.js";

const log = getLogger("snapshot-lock");

/**
 * Upper bound on acquire-loop iterations. Each stale-takeover attempt that
 * loses a rename race or re-acquire race counts as one iteration. The loop
 * is bounded so that a pathological contention pattern (many processes each
 * racing into a newly freed slot) cannot turn into an unbounded spin.
 */
const MAX_ACQUIRE_ITERATIONS = 8;

/**
 * Delay between acquire-loop iterations when we lose a race and need to
 * retry. Small enough that legitimate contention resolves quickly and large
 * enough that we don't hammer the filesystem.
 */
const ACQUIRE_RETRY_DELAY_MS = 10;

/**
 * Extra delay when we see an empty lock file (suggesting another process
 * is mid-write between `openSync(O_EXCL)` succeeding and `writeSync(payload)`
 * completing). 20ms is plenty of time for the writer to finish a
 * fixed-size `<pid> <timestamp>` payload.
 */
const EMPTY_FILE_RETRY_DELAY_MS = 20;

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
 *
 * The write-then-close sequence is ordered so that the payload is flushed
 * before any other process can read the file. Callers must still verify
 * ownership after a successful create to defend against the (theoretical)
 * case where an atomic rename replaces the file between our close and our
 * next action.
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
 * Read back the lock file after a successful `tryAtomicCreateLock` and
 * confirm that the holder PID matches `process.pid`. Returns `true` if we
 * own the lock, `false` otherwise. Used as a defense-in-depth check against
 * the (theoretical) case where another process atomically replaced our
 * lock file between our `writeSync` and the next caller's `readFileSync`.
 *
 * Returns `false` for an empty file as well — if the contents have not yet
 * been flushed (which should not happen since we `writeSync` before
 * returning), we conservatively treat it as "not our lock".
 */
function verifyLockOwnership(lockPath: string): boolean {
  const pid = readLockHolderPid(lockPath);
  return pid === process.pid;
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
 * ## Stale-lock takeover (TOCTOU-safe)
 *
 * The naive "detect stale → unlink → re-acquire" pattern has a TOCTOU
 * race: two processes can both observe the same stale lock, both call
 * `unlink`, and the second unlink removes the *fresh* lock the first
 * process just re-acquired. Both then succeed at `O_EXCL` create and
 * believe they own the lock.
 *
 * This implementation uses a **rename-aside-then-verify** pattern instead:
 *
 *   1. Atomically rename the stale lock to a unique sideband path
 *      (`<lockPath>.stale.<pid>.<timestamp>`). `rename(2)` is atomic; if two
 *      processes race, only one wins. The loser sees `ENOENT` and retries
 *      the acquire loop from the top.
 *   2. The winner attempts `O_EXCL` create on the now-empty `lockPath`. On
 *      success it unlinks the sideband file and verifies ownership by
 *      reading back the PID it wrote.
 *   3. Post-acquire verification runs for *every* successful create (not
 *      just the takeover path). If the read-back PID doesn't match
 *      `process.pid`, we release our idea-of-a-lock as a race and throw —
 *      crucially, without unlinking, so we don't destroy whoever does own
 *      it.
 *
 * ## Partial-write handling
 *
 * There is a tiny window between `openSync(O_EXCL)` succeeding and
 * `writeSync(payload)` completing where another reader could observe a
 * zero-byte lock file. If we see an empty file on inspection, we sleep
 * briefly and re-read — if it's still empty, we treat it as stale and
 * proceed with the rename-aside takeover.
 *
 * ## Bounded retry
 *
 * The loop is bounded by `MAX_ACQUIRE_ITERATIONS`. A pathological contention
 * pattern (e.g. many backup processes each taking over each other's leftovers
 * faster than we can verify ownership) cannot turn into an unbounded spin.
 * After the bound is exhausted we surface a conflict so callers retry.
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

  let lastHolderPid: number | null = null;

  for (let attempt = 0; attempt < MAX_ACQUIRE_ITERATIONS; attempt += 1) {
    // --- Step 1: try fresh atomic create ---
    if (tryAtomicCreateLock(lockPath)) {
      // Post-acquire verification. If another process managed to atomically
      // replace our lock between our `writeSync` and now (which should not
      // happen under O_EXCL, but we verify as defense in depth), someone
      // else owns it — report conflict without unlinking so we don't
      // destroy their lock.
      if (verifyLockOwnership(lockPath)) {
        return makeRelease(lockPath);
      }
      const winnerPid = readLockHolderPid(lockPath);
      throw new Error(
        winnerPid != null
          ? `snapshot in progress (locked by pid ${winnerPid})`
          : "snapshot in progress (race detected)",
      );
    }

    // --- Step 2: inspect the existing lock ---
    let holderPid = readLockHolderPid(lockPath);

    // Partial-write window: the file exists but has no parseable PID. This
    // can happen in the tiny window between `O_EXCL` create and the payload
    // write, so we retry once after a short sleep.
    if (holderPid == null) {
      await sleep(EMPTY_FILE_RETRY_DELAY_MS);
      holderPid = readLockHolderPid(lockPath);
    }

    if (holderPid != null && isProcessAlive(holderPid)) {
      throw new Error(
        `snapshot in progress (locked by pid ${holderPid})`,
      );
    }

    // --- Step 3: stale takeover via rename-aside ---
    //
    // Atomically rename the stale lock to a unique sideband path. If two
    // processes race, only one wins the rename — the loser sees ENOENT and
    // retries the acquire loop from the top. The winner's next `tryAcquire`
    // can then succeed on the empty slot.
    lastHolderPid = holderPid;
    const sidebandPath = `${lockPath}.stale.${process.pid}.${Date.now()}.${attempt}`;
    log.info(
      { lockPath, holderPid, sidebandPath },
      "Taking over stale snapshot lock via rename-aside",
    );
    try {
      renameSync(lockPath, sidebandPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // Another process already renamed the stale lock away. Retry the
        // whole loop — the slot may be free or may have a new legitimate
        // holder.
        await sleep(ACQUIRE_RETRY_DELAY_MS);
        continue;
      }
      throw err;
    }

    // The sideband file is ours to clean up. Best-effort unlink; if it
    // fails, the file will sit around as orphaned debris, but it does not
    // affect correctness (the name includes our pid and timestamp so it
    // won't collide with a future run).
    try {
      unlinkSync(sidebandPath);
    } catch {
      // best-effort
    }

    // Loop back to attempt the acquire on the now-empty slot. Do not break
    // out here — control flow falls through to the next iteration which
    // calls `tryAtomicCreateLock` again.
    await sleep(ACQUIRE_RETRY_DELAY_MS);
  }

  // Ran out of attempts. This should be vanishingly rare — it would require
  // sustained multi-way contention with every attempt losing a rename or
  // acquire race. Surface as a conflict so the caller can retry.
  throw new Error(
    lastHolderPid != null
      ? `snapshot in progress (contended, last seen pid ${lastHolderPid})`
      : "snapshot in progress (lock contended)",
  );
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
