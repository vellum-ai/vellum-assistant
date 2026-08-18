import fs from "node:fs";
import path from "node:path";

export type LockfileLockResult<T> =
  { ok: true; value: T } | { ok: false; error: string };

/** Minimum age before a lock is even considered for breaking; the owner pid
 *  check is what decides, so a live-but-slow holder is never stolen from. */
const STALE_LOCK_MS = 5_000;
/** A pid is not stable identity: a crashed holder's pid can be recycled to an
 *  unrelated long-lived process, which would wedge writers forever. Real holds
 *  last microseconds, so past this ceiling the pid check is ignored. */
const HARD_STALE_LOCK_MS = 10 * 60_000;
const ACQUIRE_ATTEMPTS = 10;
const RETRY_DELAY_MS = 25;

/** Locks held by this process, so composed writers reenter instead of deadlocking. */
const heldLocks = new Set<string>();

/** Disambiguates concurrent break attempts within one process. */
let breakCounter = 0;

/** Node-compatible synchronous sleep (no Bun.sleepSync in Electron/Vite hosts). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ownerFilePath(lockDir: string): string {
  return path.join(lockDir, "owner");
}

function readOwnerPid(lockDir: string): number | null {
  try {
    const pid = Number(fs.readFileSync(ownerFilePath(lockDir), "utf-8"));
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the pid exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function tryBreakStaleLock(lockDir: string): void {
  try {
    const age = Date.now() - fs.statSync(lockDir).mtimeMs;
    if (age <= STALE_LOCK_MS) return;
    if (age <= HARD_STALE_LOCK_MS) {
      const ownerPid = readOwnerPid(lockDir);
      if (ownerPid !== null && isProcessAlive(ownerPid)) return;
    }
    // Rename before removing so exactly one contender wins the break.
    const tombstone = `${lockDir}.stale-${process.pid}-${breakCounter++}`;
    fs.renameSync(lockDir, tombstone);
    fs.rmSync(tombstone, { recursive: true, force: true });
  } catch {
    // Holder released or another contender broke it; next mkdir attempt decides.
  }
}

/** Remove the lock only if this process still owns it: a lock broken as stale
 *  and re-acquired while `fn` ran records the replacement holder's pid. */
function releaseLock(lockDir: string): void {
  try {
    if (readOwnerPid(lockDir) !== process.pid) return;
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // Best effort; a leftover dir is broken once its owner process dies.
  }
}

/**
 * Run `fn` under a cross-process advisory lock keyed to the lockfile write
 * path (`lockfilePaths[0]`). The lock is a `${writePath}.lock` directory:
 * mkdir has O_EXCL semantics on every platform, so exactly one process wins.
 * The winner records its pid in an `owner` file; a contender breaks the lock
 * only when the recorded owner process is gone (or never recorded ownership),
 * except past a hard age ceiling that bounds recovery from pid reuse.
 * Acquisition is bounded (~250ms worst case) and failure
 * is returned structurally rather than thrown, so never-throw seams stay
 * never-throw; `fn`'s own exceptions propagate, with the lock released in
 * `finally`.
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
    try {
      fs.writeFileSync(ownerFilePath(lockDir), String(process.pid));
    } catch (err) {
      try {
        fs.rmSync(lockDir, { recursive: true, force: true });
      } catch {
        // An ownerless dir is broken as stale once it ages out.
      }
      return {
        ok: false,
        error: `Failed to record lockfile lock ownership: ${err}`,
      };
    }
    acquired = true;
    break;
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
    releaseLock(lockDir);
  }
}
