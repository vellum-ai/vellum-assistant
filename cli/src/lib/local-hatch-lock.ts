import { execFileSync } from "child_process";
import { createHash, randomUUID } from "crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { hostname, userInfo } from "os";
import { dirname, join } from "path";

const DEFAULT_TIMEOUT_MS = 240_000;
const DEFAULT_RETRY_MS = 100;
const MAX_LOCK_AGE_MS = DEFAULT_TIMEOUT_MS - 60_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const LIVE_OWNER_RECOVERY_GRACE_MS = 10_000;

interface LocalHatchLockOptions {
  lockPath?: string;
  liveOwnerRecoveryGraceMs?: number;
  timeoutMs?: number;
  retryMs?: number;
}

interface LockOwner {
  pid: number;
  processStartedAt?: string;
  token: string;
}

interface LockSnapshot {
  owner?: LockOwner;
  signature: string;
}

export function resolveLocalHatchLockPath(): string {
  const machineKey = createHash("sha256")
    .update(hostname())
    .digest("hex")
    .slice(0, 12);
  return join(
    userInfo().homedir,
    ".cache",
    "vellum",
    "runtime",
    machineKey,
    "local-hatch.lock",
  );
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function processStartedAt(pid: number): string | undefined {
  try {
    const value = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    }).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function parseOwner(raw: string): LockOwner | undefined {
  try {
    const parsed = JSON.parse(raw) as {
      pid?: unknown;
      processStartedAt?: unknown;
      token?: unknown;
    };
    if (
      typeof parsed.pid === "number" &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.token === "string" &&
      parsed.token.length > 0
    ) {
      return {
        pid: parsed.pid,
        processStartedAt:
          typeof parsed.processStartedAt === "string" &&
          parsed.processStartedAt.length > 0
            ? parsed.processStartedAt
            : undefined,
        token: parsed.token,
      };
    }
  } catch {}
  return undefined;
}

function readSnapshot(path: string): LockSnapshot | undefined {
  try {
    const raw = readFileSync(path, "utf-8");
    return {
      owner: parseOwner(raw),
      signature: createHash("sha256").update(raw).digest("hex"),
    };
  } catch {
    return undefined;
  }
}

function readOwner(path: string): LockOwner | undefined {
  return readSnapshot(path)?.owner;
}

function fileAgeMs(path: string): number | undefined {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

const expiredLiveOwners = new Map<string, number>();

function ownerIsActive(
  path: string,
  owner: LockOwner | undefined,
  liveOwnerRecoveryGraceMs: number,
): boolean {
  const ageMs = fileAgeMs(path);
  if (!owner) {
    return ageMs !== undefined && ageMs < MAX_LOCK_AGE_MS;
  }
  if (!processIsAlive(owner.pid)) {
    return false;
  }
  if (owner.processStartedAt) {
    const currentStartedAt = processStartedAt(owner.pid);
    if (currentStartedAt) {
      expiredLiveOwners.delete(owner.token);
      return currentStartedAt === owner.processStartedAt;
    }
  }
  if (ageMs !== undefined && ageMs < MAX_LOCK_AGE_MS) {
    expiredLiveOwners.delete(owner.token);
    return true;
  }

  const firstExpiredAt = expiredLiveOwners.get(owner.token) ?? Date.now();
  expiredLiveOwners.set(owner.token, firstExpiredAt);
  if (Date.now() - firstExpiredAt < liveOwnerRecoveryGraceMs) {
    return true;
  }
  return false;
}

function writeOwnerFile(path: string, owner: LockOwner): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(owner) + "\n");
  } finally {
    closeSync(fd);
  }
}

function acquireRecoveryClaim(
  lockPath: string,
  staleSignature: string,
  owner: LockOwner,
  liveOwnerRecoveryGraceMs: number,
): (() => void) | undefined {
  const recoveryKey = staleSignature.slice(0, 16);
  for (let generation = 0; generation < 100; generation++) {
    const claimPath = `${lockPath}.recovery-${recoveryKey}-${generation}`;
    try {
      writeOwnerFile(claimPath, owner);
      return () => releaseLock(claimPath, owner.token);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (
        ownerIsActive(claimPath, readOwner(claimPath), liveOwnerRecoveryGraceMs)
      ) {
        return undefined;
      }
    }
  }
  return undefined;
}

function removeStaleLock(
  lockPath: string,
  recoveryOwner: LockOwner,
  liveOwnerRecoveryGraceMs: number,
): boolean {
  const staleSnapshot = readSnapshot(lockPath);
  if (!staleSnapshot) {
    return true;
  }
  if (ownerIsActive(lockPath, staleSnapshot.owner, liveOwnerRecoveryGraceMs)) {
    return false;
  }

  const releaseRecoveryClaim = acquireRecoveryClaim(
    lockPath,
    staleSnapshot.signature,
    recoveryOwner,
    liveOwnerRecoveryGraceMs,
  );
  if (!releaseRecoveryClaim) {
    return false;
  }

  try {
    const currentSnapshot = readSnapshot(lockPath);
    if (!currentSnapshot) {
      return true;
    }
    if (currentSnapshot.signature !== staleSnapshot.signature) {
      return false;
    }
    if (
      ownerIsActive(lockPath, currentSnapshot.owner, liveOwnerRecoveryGraceMs)
    ) {
      return false;
    }
    try {
      unlinkSync(lockPath);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  } finally {
    releaseRecoveryClaim();
  }
}

function releaseLock(lockPath: string, token: string): void {
  if (readOwner(lockPath)?.token !== token) {
    return;
  }
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function refreshLock(lockPath: string, token: string): void {
  if (readOwner(lockPath)?.token !== token) {
    return;
  }
  try {
    const now = new Date();
    utimesSync(lockPath, now, now);
  } catch {}
}

/**
 * Serialize local assistant startup across CLI processes. Port availability is
 * machine-wide even when callers use different lockfile or XDG directories,
 * so allocation must remain exclusive until the new services have bound their
 * ports and the assistant entry has been persisted.
 */
export async function withLocalHatchLock<T>(
  action: () => Promise<T>,
  options: LocalHatchLockOptions = {},
): Promise<T> {
  const lockPath = options.lockPath ?? resolveLocalHatchLockPath();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const liveOwnerRecoveryGraceMs =
    options.liveOwnerRecoveryGraceMs ?? LIVE_OWNER_RECOVERY_GRACE_MS;
  const deadline = Date.now() + timeoutMs;
  const owner: LockOwner = {
    pid: process.pid,
    processStartedAt: processStartedAt(process.pid),
    token: `${process.pid}-${randomUUID()}`,
  };

  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });

  while (true) {
    try {
      writeOwnerFile(lockPath, owner);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (removeStaleLock(lockPath, owner, liveOwnerRecoveryGraceMs)) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for another local assistant to finish starting (${lockPath})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, retryMs));
      continue;
    }

    const heartbeat = setInterval(
      () => refreshLock(lockPath, owner.token),
      HEARTBEAT_INTERVAL_MS,
    );
    try {
      return await action();
    } finally {
      clearInterval(heartbeat);
      releaseLock(lockPath, owner.token);
    }
  }
}
