import { randomUUID } from "crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

const DEFAULT_TIMEOUT_MS = 240_000;
const DEFAULT_RETRY_MS = 100;
const UNKNOWN_OWNER_STALE_MS = DEFAULT_TIMEOUT_MS;

interface LocalHatchLockOptions {
  lockPath?: string;
  timeoutMs?: number;
  retryMs?: number;
}

interface LockOwner {
  pid: number;
  token: string;
}

function defaultLockPath(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  const lockDir = join(tmpdir(), `vellum-${uid}`);
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  return join(lockDir, "local-hatch.lock");
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readOwner(lockPath: string): LockOwner | undefined {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf-8")) as {
      pid?: unknown;
      token?: unknown;
    };
    if (
      typeof parsed.pid === "number" &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.token === "string" &&
      parsed.token.length > 0
    ) {
      return { pid: parsed.pid, token: parsed.token };
    }
  } catch {}
  return undefined;
}

function removeStaleLock(lockPath: string): boolean {
  const owner = readOwner(lockPath);
  if (owner) {
    if (processIsAlive(owner.pid)) {
      return false;
    }
  } else {
    try {
      if (Date.now() - statSync(lockPath).mtimeMs < UNKNOWN_OWNER_STALE_MS) {
        return false;
      }
    } catch {
      return true;
    }
  }

  try {
    unlinkSync(lockPath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
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
  const lockPath = options.lockPath ?? defaultLockPath();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const deadline = Date.now() + timeoutMs;
  const token = `${process.pid}-${randomUUID()}`;

  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });

  while (true) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, token }) + "\n");
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (removeStaleLock(lockPath)) {
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

    try {
      return await action();
    } finally {
      releaseLock(lockPath, token);
    }
  }
}
