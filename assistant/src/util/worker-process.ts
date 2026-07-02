/**
 * Generic control surface for a background worker OS process tracked via a
 * PID file: probe liveness, spawn an entry script and wait for readiness,
 * and signal the process to stop.
 *
 * Domain modules (memory jobs worker, resource monitor, schedule worker) wrap
 * these helpers with their own PID path, entry point, and error type — the
 * PID-file bookkeeping lives here in one place.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";

import { getCurrentLogFilePath } from "./logger.js";

export interface WorkerProcessStatus {
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
 * not_running. Intended for worker-process PID files whose PID is a normal
 * spawned child (never PID 1), so `process.kill(pid, 0)` liveness is reliable.
 */
export function probeWorkerPidFile(path: string): WorkerProcessStatus {
  if (!existsSync(path)) {
    return { status: "not_running" };
  }

  const raw = readFileSync(path, "utf-8").trim();
  const pid = parseInt(raw, 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    return { status: "not_running" };
  }

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
    // Any other error (e.g. EPERM: the process exists but this caller may not
    // signal it) means the process is alive. Report it running rather than
    // letting the error escape a status probe.
    return { status: "running", pid };
  }
}

/** Thrown when a worker process fails to come up within the wait window. */
export class WorkerProcessSpawnError extends Error {}

/**
 * How long {@link spawnWorkerProcess} waits for the freshly-spawned worker to
 * write its PID file before treating the spawn as failed. A cold `bun run`
 * start — new runtime, config load, DB open — routinely takes several
 * seconds, so this is deliberately generous: a premature timeout makes a
 * `start` command report failure for a worker that is merely slow.
 */
const PID_FILE_WAIT_TIMEOUT_MS = 15_000;

/** Poll interval while waiting for the worker's PID file to appear. */
const PID_FILE_POLL_INTERVAL_MS = 100;

export interface SpawnWorkerProcessOptions {
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
   * When the wait times out while the child is still alive (a hung or very
   * slow start), terminate that child before throwing. Callers whose failure
   * path leaves the worker's config flag off MUST set this: otherwise the
   * detached worker keeps coming up and runs alongside whatever in-process
   * fallback the flag re-enabled.
   */
  terminateOnTimeout?: boolean;
  /**
   * Process parentage (default `true`):
   *   - `true` — the worker is its own session leader and outlives the
   *     spawning process. Short-lived CLI spawners need this so the worker
   *     keeps running after the command returns.
   *   - `false` — the worker is a direct child of the spawning process. The
   *     daemon passes this so the worker it owns appears in its process tree
   *     (`assistant ps`) and is torn down with the daemon.
   * Either way the child is `unref`'d, so the spawning process never blocks on
   * it and the worker is tracked via its PID file rather than the handle.
   */
  detached?: boolean;
}

type WorkerReadyOutcome = "ready" | "exited" | "timeout";

/**
 * Wait for the worker to signal readiness by writing its PID file.
 *
 *   - `"ready"`   — the PID file appeared.
 *   - `"exited"`  — the child exited first (it crashed during startup).
 *   - `"timeout"` — neither happened within `timeoutMs`.
 *
 * Polls for the PID file but also watches `exited`, so a crash-on-startup
 * fails fast instead of waiting out the whole timeout.
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
  // A pending `exited` promise does not keep the event loop alive once the
  // child is unref'd, so this floating wait won't hang the process.
  void exited?.then(markExited, markExited);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(pidPath)) {
      return "ready";
    }
    if (childExited) {
      // The worker could write the PID file and exit in the same tick —
      // re-check before declaring it dead.
      return existsSync(pidPath) ? "ready" : "exited";
    }
    await Bun.sleep(pollIntervalMs);
  }
  return existsSync(pidPath) ? "ready" : "timeout";
}

/**
 * Spawn a worker entry script as a background process and wait for it to
 * report readiness by writing its PID file. `opts.detached` (default `true`)
 * controls process parentage — see {@link SpawnWorkerProcessOptions}.
 *
 * If a worker is already running (per the PID file), returns its PID with
 * `alreadyRunning: true` rather than spawning a second one. Throws
 * {@link WorkerProcessSpawnError} if the child crashes during startup or
 * never writes its PID file within the wait window.
 */
export async function spawnWorkerProcess(args: {
  /** PID file the worker writes on startup (and that probes read). */
  pidPath: string;
  /** Worker entry script, e.g. `new URL("./worker.ts", import.meta.url)`. */
  entry: URL;
  /** Human-readable name used in spawn-failure messages, e.g. "Memory worker". */
  workerLabel: string;
  options?: SpawnWorkerProcessOptions;
}): Promise<{ pid: number; alreadyRunning: boolean }> {
  const opts = args.options ?? {};
  const pidWaitTimeoutMs = opts.pidWaitTimeoutMs ?? PID_FILE_WAIT_TIMEOUT_MS;
  const pidPollIntervalMs = opts.pidPollIntervalMs ?? PID_FILE_POLL_INTERVAL_MS;
  const detached = opts.detached ?? true;

  const current = probeWorkerPidFile(args.pidPath);
  if (current.status === "running" && current.pid != null) {
    return { pid: current.pid, alreadyRunning: true };
  }

  // Pipe the worker's stderr into the same daily log file the daemon writes
  // to. The worker's pino logger already writes there directly, but stderr
  // captures crash traces (uncaught exceptions that bypass the catch handler)
  // and pino's fallback output if the file logger fails to initialize.
  // Without this, any such output is lost to /dev/null and the worker dies
  // silently.
  let stderrFd: number | "inherit" = "inherit";
  try {
    const logPath = getCurrentLogFilePath();
    mkdirSync(dirname(logPath), { recursive: true });
    stderrFd = openSync(logPath, "a", 0o600);
  } catch {
    // If the log file can't be opened, inherit the parent's stderr so crash
    // output is at least visible to the spawning process.
  }

  const child = Bun.spawn({
    cmd: ["bun", "run", args.entry.pathname],
    stdio: ["ignore", "ignore", stderrFd],
    detached,
  });

  // Close our copy of the log fd — the child has its own.
  if (typeof stderrFd === "number") {
    closeSync(stderrFd);
  }

  // Unreference so the spawning process doesn't wait for the child.
  child.unref();

  // The child is `unref`'d, so a worker that is merely slow keeps coming up
  // after we stop waiting.
  const outcome = await waitForWorkerPidFile(
    args.pidPath,
    child.exited,
    pidWaitTimeoutMs,
    pidPollIntervalMs,
  );

  if (outcome !== "ready") {
    // On a plain timeout the child may still be alive (hung or very slow
    // start). Terminate it when asked so a worker we are reporting as failed
    // cannot come up later. On an early exit the child is already gone, so
    // there is nothing to kill.
    if (outcome === "timeout" && opts.terminateOnTimeout) {
      try {
        child.kill();
      } catch {
        // best-effort — the child may already be gone
      }
    }
    throw new WorkerProcessSpawnError(
      outcome === "exited"
        ? `${args.workerLabel} exited during startup before writing its PID file`
        : `${args.workerLabel} was spawned but did not write its PID file within ${Math.round(
            pidWaitTimeoutMs / 1000,
          )}s`,
    );
  }

  const pid = parseInt(readFileSync(args.pidPath, "utf-8").trim(), 10);
  return { pid, alreadyRunning: false };
}

/**
 * Send SIGTERM to the worker process behind `pidPath` if it is actually
 * running.
 *
 * Returns the status observed before signalling, so callers can report
 * whether anything was stopped. Only throws if `process.kill` itself fails
 * (e.g. EPERM) — a not-running worker is a no-op.
 */
export function stopWorkerProcess(pidPath: string): WorkerProcessStatus {
  const current = probeWorkerPidFile(pidPath);
  if (current.status === "running" && current.pid != null) {
    process.kill(current.pid, "SIGTERM");
  }
  return current;
}
