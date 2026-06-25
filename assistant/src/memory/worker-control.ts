/**
 * Shared control surface for the memory jobs worker *process* — the detached
 * OS process whose entry point is `worker-process.ts`.
 *
 * Both the `assistant memory worker` CLI and the daemon lifecycle (when
 * `memory.worker.enabled` is set) need to probe, spawn, and stop this process,
 * so the PID-file bookkeeping lives here in one place.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { getCurrentLogFilePath } from "../util/logger.js";
import {
  getMemorySyncRunnerMarkerPath,
  getMemoryWorkerPidPath,
} from "../util/platform.js";

export interface MemoryWorkerStatus {
  status: "running" | "not_running";
  pid?: number;
}

/** True when `err` is a Node ESRCH error ("no such process"). */
function isEsrchError(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code?: unknown }).code === "ESRCH"
  );
}

/**
 * Read a PID file and report liveness. A missing or malformed file reports
 * not_running; a file pointing at a dead process is cleaned up and reported as
 * not_running. Shared by the worker-process PID file and the sync-runner
 * marker so both probe identically.
 */
function probePidFile(path: string): MemoryWorkerStatus {
  if (!existsSync(path)) return { status: "not_running" };

  const raw = readFileSync(path, "utf-8").trim();
  const pid = parseInt(raw, 10);
  if (!Number.isFinite(pid) || pid <= 0) return { status: "not_running" };

  try {
    process.kill(pid, 0);
    return { status: "running", pid };
  } catch (err: unknown) {
    if (isEsrchError(err)) {
      // Stale file — clean it up.
      try {
        unlinkSync(path);
      } catch {
        // best-effort
      }
      return { status: "not_running" };
    }
    throw err;
  }
}

/**
 * Inspect the PID file to determine whether the worker process is alive.
 * A stale PID file (pointing at a dead process) is cleaned up and reported
 * as not_running.
 */
export function probeMemoryWorker(): MemoryWorkerStatus {
  return probePidFile(getMemoryWorkerPidPath());
}

/**
 * Inspect the sync-runner marker to determine whether the daemon's in-process
 * synchronous runner is currently draining the memory-job queue. The daemon's
 * worker supervisor writes the marker (with its own PID) only while it owns
 * processing, so a live marker means the synchronous runner is going. A stale
 * marker (daemon gone) is cleaned up and reported as not_running.
 */
export function probeSyncRunner(): MemoryWorkerStatus {
  return probePidFile(getMemorySyncRunnerMarkerPath());
}

/**
 * Publish the sync-runner marker recording `pid` (the daemon process). Called
 * by the worker supervisor when its in-process synchronous runner takes over
 * processing. Best-effort: a write failure only affects status reporting, not
 * job processing.
 */
export function writeSyncRunnerMarker(pid: number): void {
  try {
    writeFileSync(getMemorySyncRunnerMarkerPath(), String(pid), { flag: "w" });
  } catch {
    // best-effort — the marker is a status hint, not a correctness invariant
  }
}

/**
 * Remove the sync-runner marker. Called by the worker supervisor when it stands
 * down for an out-of-process worker, and on daemon shutdown. Best-effort.
 */
export function removeSyncRunnerMarker(): void {
  try {
    const path = getMemorySyncRunnerMarkerPath();
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // best-effort
  }
}

export class MemoryWorkerSpawnError extends Error {}

/**
 * Spawn the memory worker as a detached background process.
 *
 * If a worker is already running, returns its PID with `alreadyRunning: true`
 * rather than spawning a second one. Throws {@link MemoryWorkerSpawnError} if
 * the child is spawned but never writes its PID file (i.e. failed to start).
 */
export async function spawnMemoryWorkerProcess(): Promise<{
  pid: number;
  alreadyRunning: boolean;
}> {
  const current = probeMemoryWorker();
  if (current.status === "running" && current.pid != null) {
    return { pid: current.pid, alreadyRunning: true };
  }

  const pidPath = getMemoryWorkerPidPath();
  const entry = new URL("./worker-process.ts", import.meta.url);

  // Pipe the worker's stderr into the same daily log file the daemon
  // writes to. The worker's pino logger already writes there directly,
  // but stderr captures crash traces (uncaught exceptions that bypass
  // the catch handler) and pino's fallback output if the file logger
  // fails to initialize. Without this, any such output is lost to
  // /dev/null and the worker dies silently.
  let stderrFd: number | "inherit" = "inherit";
  try {
    const logPath = getCurrentLogFilePath();
    mkdirSync(dirname(logPath), { recursive: true });
    stderrFd = openSync(logPath, "a", 0o600);
  } catch {
    // If the log file can't be opened, inherit the parent's stderr so
    // crash output is at least visible to the spawning process.
  }

  // Spawn detached so the worker survives the spawning process exiting.
  const child = Bun.spawn({
    cmd: ["bun", "run", entry.pathname],
    stdio: ["ignore", "ignore", stderrFd],
    detached: true,
  });

  // Close our copy of the log fd — the child has its own.
  if (typeof stderrFd === "number") {
    closeSync(stderrFd);
  }

  // Unreference so the spawning process doesn't wait for the child.
  child.unref();

  // Wait briefly for the PID file to appear (the worker writes it on startup).
  let pidWritten = false;
  for (let i = 0; i < 10; i++) {
    await Bun.sleep(100);
    if (existsSync(pidPath)) {
      pidWritten = true;
      break;
    }
  }

  if (!pidWritten) {
    throw new MemoryWorkerSpawnError(
      "Memory worker was spawned but PID file did not appear within 1s",
    );
  }

  const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
  return { pid, alreadyRunning: false };
}

/**
 * Send SIGTERM to the worker process if it is actually running.
 *
 * Returns the status observed before signalling, so callers can report
 * whether anything was stopped. Only throws if `process.kill` itself fails
 * (e.g. EPERM) — a not-running worker is a no-op.
 */
export function stopMemoryWorkerProcess(): MemoryWorkerStatus {
  const current = probeMemoryWorker();
  if (current.status === "running" && current.pid != null) {
    process.kill(current.pid, "SIGTERM");
  }
  return current;
}
