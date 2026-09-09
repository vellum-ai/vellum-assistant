/**
 * Cross-process lock for the workspace git transaction (status/add/diff/commit
 * plus history compaction).
 *
 * Heartbeat auto-commits run in the resource monitor process. Turn-boundary
 * and shutdown commits run in the daemon. Each process has its own in-memory
 * mutex, so those mutexes cannot serialize the two writers. Git `index.lock`
 * covers a single git command, not the full transaction.
 *
 * This lock is an atomic `O_CREAT | O_EXCL` file at
 * `<workspace>/workspace-git.lock`, following the rename-aside stale-takeover
 * pattern in `backup/snapshot-lock.ts`. Callers take the in-process mutex
 * first, then this file lock, so same-process waiters do not hammer O_EXCL.
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
import { setTimeout as sleep } from "node:timers/promises";

import { getLogger } from "../util/logger.js";
import { isProcessAlive } from "../util/process-liveness.js";

const log = getLogger("workspace-git-lock");

/**
 * Delay between acquire-loop iterations when the lock is held by a live
 * peer, or after losing a stale-takeover race.
 */
const ACQUIRE_POLL_MS = 25;

/**
 * Per-attempt delay when we see an empty lock file (another process is
 * mid-write between `openSync(O_EXCL)` succeeding and `writeSync`).
 */
const EMPTY_FILE_RETRY_DELAY_MS = 50;

/**
 * Re-reads of an empty lock file before treating it as crash debris.
 * Three retries at 50ms bound the wait at ~150ms.
 */
const EMPTY_FILE_MAX_RETRIES = 3;

/**
 * Age past which a lock held by an apparently-live PID is taken over.
 *
 * Needed for container PID 1: after a restart `isProcessAlive(1)` reports
 * the new assistant as alive even though it did not write the lock.
 * History compaction chains several git commands each bounded at 10 minutes,
 * and large batched commits can also run for minutes, so this TTL sits well
 * above those holds. A lock whose timestamp predates this process's start
 * is taken over sooner when the holder PID is ours (PID reuse).
 */
export const WORKSPACE_GIT_REPO_LOCK_STALE_TTL_MS = 4 * 60 * 60 * 1000;

export class WorkspaceGitRepoLockTimeout extends Error {
  constructor(message = "Workspace git repo lock wait timed out") {
    super(message);
    this.name = "WorkspaceGitRepoLockTimeout";
  }
}

export function getWorkspaceGitRepoLockPath(workspaceDir: string): string {
  return join(workspaceDir, "workspace-git.lock");
}

function deadlineExpired(deadlineMs?: number): boolean {
  return deadlineMs !== undefined && Date.now() >= deadlineMs;
}

function remainingWaitMs(deadlineMs?: number): number {
  if (deadlineMs === undefined) {
    return ACQUIRE_POLL_MS;
  }
  return Math.max(0, Math.min(ACQUIRE_POLL_MS, deadlineMs - Date.now()));
}

function tryAtomicCreateLock(lockPath: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(
      lockPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    const payload = `${process.pid} ${Date.now()}\n`;
    writeSync(fd, payload);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      return false;
    }
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

type LockReadResult =
  | { kind: "pid"; pid: number; timestamp: number | null }
  | { kind: "empty" }
  | { kind: "missing" };

function readLockHolder(lockPath: string): LockReadResult {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { kind: "missing" };
    }
    return { kind: "empty" };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { kind: "empty" };
  }
  const match = /^(\d+)(?:\s+(\d+))?/.exec(trimmed);
  if (!match) {
    return { kind: "empty" };
  }
  const pid = Number.parseInt(match[1], 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    return { kind: "empty" };
  }
  const timestamp =
    match[2] !== undefined ? Number.parseInt(match[2], 10) : null;
  return {
    kind: "pid",
    pid,
    timestamp:
      timestamp !== null && Number.isFinite(timestamp) ? timestamp : null,
  };
}

function verifyLockOwnership(lockPath: string): boolean {
  const result = readLockHolder(lockPath);
  return result.kind === "pid" && result.pid === process.pid;
}

function processStartMs(): number {
  return Date.now() - process.uptime() * 1000;
}

/**
 * A holder is stale when:
 *   - the PID is not running
 *   - the PID is this process but the lock predates our start (PID reuse,
 *     including container PID 1 after restart)
 *   - the lock is older than {@link WORKSPACE_GIT_REPO_LOCK_STALE_TTL_MS}
 */
function isHolderStale(holder: {
  pid: number;
  timestamp: number | null;
}): boolean {
  if (!isProcessAlive(holder.pid)) {
    return true;
  }
  if (holder.timestamp === null) {
    return false;
  }
  if (
    holder.pid === process.pid &&
    holder.timestamp < processStartMs() - 1000
  ) {
    return true;
  }
  return Date.now() - holder.timestamp > WORKSPACE_GIT_REPO_LOCK_STALE_TTL_MS;
}

function makeRelease(lockPath: string): () => Promise<void> {
  let released = false;
  return async () => {
    if (released) {
      return;
    }
    released = true;
    try {
      unlinkSync(lockPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        log.warn(
          { err, lockPath },
          "Failed to release workspace git repo lock (best-effort)",
        );
      }
    }
  };
}

async function takeOverStaleLock(
  lockPath: string,
  holderPid: number,
  attempt: number,
): Promise<void> {
  const sidebandPath = `${lockPath}.stale.${process.pid}.${Date.now()}.${attempt}`;
  log.info(
    { lockPath, holderPid, sidebandPath },
    "Taking over stale workspace git repo lock via rename-aside",
  );
  try {
    renameSync(lockPath, sidebandPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return;
    }
    throw err;
  }
  try {
    unlinkSync(sidebandPath);
  } catch {
    // best-effort
  }
}

/**
 * Acquire the workspace git repo lock, waiting until it is free or
 * `deadlineMs` is reached.
 *
 * On success, returns an idempotent release function. Invoke it in a
 * `finally` block.
 */
export async function acquireWorkspaceGitRepoLock(
  lockPath: string,
  options?: { deadlineMs?: number },
): Promise<() => Promise<void>> {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });

  let attempt = 0;
  while (true) {
    if (deadlineExpired(options?.deadlineMs)) {
      throw new WorkspaceGitRepoLockTimeout();
    }

    if (tryAtomicCreateLock(lockPath)) {
      if (verifyLockOwnership(lockPath)) {
        return makeRelease(lockPath);
      }
      const waitMs = remainingWaitMs(options?.deadlineMs);
      if (waitMs === 0) {
        throw new WorkspaceGitRepoLockTimeout();
      }
      await sleep(waitMs);
      continue;
    }

    let holder = readLockHolder(lockPath);
    if (holder.kind === "missing") {
      const waitMs = remainingWaitMs(options?.deadlineMs);
      if (waitMs === 0) {
        throw new WorkspaceGitRepoLockTimeout();
      }
      await sleep(waitMs);
      continue;
    }

    for (
      let retry = 0;
      retry < EMPTY_FILE_MAX_RETRIES && holder.kind === "empty";
      retry += 1
    ) {
      await sleep(EMPTY_FILE_RETRY_DELAY_MS);
      holder = readLockHolder(lockPath);
    }

    if (holder.kind === "missing") {
      const waitMs = remainingWaitMs(options?.deadlineMs);
      if (waitMs === 0) {
        throw new WorkspaceGitRepoLockTimeout();
      }
      await sleep(waitMs);
      continue;
    }

    if (holder.kind === "empty") {
      // Past the partial-write window: treat leftover empty files as crash
      // debris. Rename-aside so two waiters cannot both unlink a live
      // holder's in-progress lock.
      await takeOverStaleLock(lockPath, 0, attempt);
      attempt += 1;
      continue;
    }

    if (!isHolderStale(holder)) {
      const waitMs = remainingWaitMs(options?.deadlineMs);
      if (waitMs === 0) {
        throw new WorkspaceGitRepoLockTimeout();
      }
      await sleep(waitMs);
      continue;
    }

    await takeOverStaleLock(lockPath, holder.pid, attempt);
    attempt += 1;
    const waitMs = remainingWaitMs(options?.deadlineMs);
    if (waitMs === 0) {
      throw new WorkspaceGitRepoLockTimeout();
    }
    await sleep(waitMs);
  }
}

export async function withWorkspaceGitRepoLock<T>(
  workspaceDir: string,
  fn: () => Promise<T>,
  options?: { deadlineMs?: number },
): Promise<T> {
  const release = await acquireWorkspaceGitRepoLock(
    getWorkspaceGitRepoLockPath(workspaceDir),
    options,
  );
  try {
    return await fn();
  } finally {
    await release();
  }
}
