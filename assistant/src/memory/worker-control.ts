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
 * How long {@link spawnMemoryWorkerProcess} waits for the freshly-spawned worker
 * to write its PID file before treating the spawn as failed. A cold
 * `bun run worker-process.ts` start — new runtime, config load, DB open —
 * routinely takes several seconds, so this is deliberately generous: a premature
 * timeout makes `assistant memory worker start` report failure for a worker that
 * is merely slow, and (because the CLI failure path leaves
 * `memory.worker.enabled` off) leaves that detached worker draining the queue
 * alongside the daemon's synchronous in-process runner — two drainers racing on
 * the same jobs.
 */
const PID_FILE_WAIT_TIMEOUT_MS = 15_000;

/** Poll interval while waiting for the worker's PID file to appear. */
const PID_FILE_POLL_INTERVAL_MS = 100;

export interface SpawnMemoryWorkerOptions {
  /**
   * Override how long to wait for the worker's PID file, in ms. Defaults to
   * {@link PID_FILE_WAIT_TIMEOUT_MS}. Primarily a testing seam.
   */
  pidWaitTimeoutMs?: number;
  /**
   * Override the PID-file poll interval, in ms. Defaults to
   * {@link PID_FILE_POLL_INTERVAL_MS}. Primarily a testing seam.
   */
  pidPollIntervalMs?: number;
  /**
   * When the wait times out while the child is still alive (a hung or very slow
   * start), terminate that child before throwing. Callers that leave
   * `memory.worker.enabled` off on failure — the CLI `memory worker start` —
   * MUST set this: otherwise the detached worker keeps coming up and drains the
   * queue behind the daemon's still-active synchronous runner. The daemon's own
   * startup spawn leaves the flag on, so a late worker there becomes the sole
   * drainer; it passes `false` to let that worker live.
   */
  terminateOnTimeout?: boolean;
}

type WorkerReadyOutcome = "ready" | "exited" | "timeout";

/**
 * Wait for the worker to signal readiness by writing its PID file.
 *
 *   - `"ready"`   — the PID file appeared.
 *   - `"exited"`  — the child exited first (it crashed during startup).
 *   - `"timeout"` — neither happened within `timeoutMs`.
 *
 * Polls for the PID file but also watches `exited`, so a crash-on-startup fails
 * fast instead of waiting out the whole timeout.
 */
async function waitForWorkerPidFile(
  pidPath: string,
  exited: Promise<unknown> | undefined,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<WorkerReadyOutcome> {
  let childExited = false;
  const markExited = () => {
    childExited = true;
  };
  // A pending `exited` promise does not keep the event loop alive once the child
  // is unref'd, so this floating wait won't hang the process.
  void exited?.then(markExited, markExited);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(pidPath)) return "ready";
    if (childExited) {
      // The worker could write the PID file and exit in the same tick — re-check
      // before declaring it dead.
      return existsSync(pidPath) ? "ready" : "exited";
    }
    await Bun.sleep(pollIntervalMs);
  }
  return existsSync(pidPath) ? "ready" : "timeout";
}

/**
 * Spawn the memory worker as a detached background process.
 *
 * If a worker is already running, returns its PID with `alreadyRunning: true`
 * rather than spawning a second one. Throws {@link MemoryWorkerSpawnError} if
 * the child crashes during startup or never writes its PID file within the
 * wait window (i.e. failed to start).
 */
export async function spawnMemoryWorkerProcess(
  opts: SpawnMemoryWorkerOptions = {},
): Promise<{
  pid: number;
  alreadyRunning: boolean;
}> {
  const pidWaitTimeoutMs = opts.pidWaitTimeoutMs ?? PID_FILE_WAIT_TIMEOUT_MS;
  const pidPollIntervalMs = opts.pidPollIntervalMs ?? PID_FILE_POLL_INTERVAL_MS;
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

  // Wait for the worker to report readiness by writing its PID file (the worker
  // writes it on startup). The child is detached, so a worker that is merely
  // slow keeps coming up after we stop waiting.
  const outcome = await waitForWorkerPidFile(
    pidPath,
    child.exited,
    pidWaitTimeoutMs,
    pidPollIntervalMs,
  );

  if (outcome !== "ready") {
    // On a plain timeout the child may still be alive (hung or very slow start).
    // Terminate it when asked so a worker we are reporting as failed cannot come
    // up later and drain the queue behind the daemon's synchronous runner. On an
    // early exit the child is already gone, so there is nothing to kill.
    if (outcome === "timeout" && opts.terminateOnTimeout) {
      try {
        child.kill();
      } catch {
        // best-effort — the child may already be gone
      }
    }
    throw new MemoryWorkerSpawnError(
      outcome === "exited"
        ? "Memory worker exited during startup before writing its PID file"
        : `Memory worker was spawned but did not write its PID file within ${Math.round(
            pidWaitTimeoutMs / 1000,
          )}s`,
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
