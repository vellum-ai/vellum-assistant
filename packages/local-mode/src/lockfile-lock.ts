import fs from "node:fs";
import path from "node:path";

export type LockfileLockResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/** A holder only holds for the microseconds a read-modify-write takes, so a
 *  lock this old belongs to a crashed process and is safe to break. */
const STALE_LOCK_MS = 5_000;
const ACQUIRE_ATTEMPTS = 10;
const RETRY_DELAY_MS = 25;

/** Locks held by this process, so composed writers reenter instead of deadlocking. */
const heldLocks = new Set<string>();

/** Node-compatible synchronous sleep (no Bun.sleepSync in Electron/Vite hosts). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function tryBreakStaleLock(lockDir: string): void {
  try {
    if (Date.now() - fs.statSync(lockDir).mtimeMs > STALE_LOCK_MS) {
      fs.rmdirSync(lockDir);
    }
  } catch {
    // Holder released or another contender broke it; next mkdir attempt decides.
  }
}

/**
 * Run `fn` under a cross-process advisory lock keyed to the lockfile write
 * path (`lockfilePaths[0]`). The lock is a `${writePath}.lock` directory:
 * mkdir has O_EXCL semantics on every platform, so exactly one process wins.
 * Acquisition is bounded (~250ms worst case) and failure is returned
 * structurally rather than thrown, so never-throw seams stay never-throw;
 * `fn`'s own exceptions propagate, with the lock released in `finally`.
 */
export function withLockfileLock<T>(
  lockfilePaths: string[],
  fn: () => T,
): LockfileLockResult<T> {
  const writePath = lockfilePaths[0];
  if (!writePath) {
    return { ok: false, error: "No lockfile path to lock" };
  }
  const lockDir = `${writePath}.lock`;

  if (heldLocks.has(lockDir)) {
    return { ok: true, value: fn() };
  }

  let acquired = false;
  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt++) {
    if (attempt > 0) sleepSync(RETRY_DELAY_MS);
    try {
      fs.mkdirSync(lockDir);
      acquired = true;
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        tryBreakStaleLock(lockDir);
        continue;
      }
      if (code === "ENOENT") {
        try {
          fs.mkdirSync(path.dirname(lockDir), { recursive: true });
        } catch {
          // Surfaced by the next mkdir attempt.
        }
        continue;
      }
      return { ok: false, error: `Failed to acquire lockfile lock: ${err}` };
    }
  }
  if (!acquired) {
    return {
      ok: false,
      error: `Timed out acquiring lockfile lock at ${lockDir}`,
    };
  }

  heldLocks.add(lockDir);
  try {
    return { ok: true, value: fn() };
  } finally {
    heldLocks.delete(lockDir);
    try {
      fs.rmdirSync(lockDir);
    } catch {
      // Best effort; a leftover dir is broken as stale by the next acquirer.
    }
  }
}
