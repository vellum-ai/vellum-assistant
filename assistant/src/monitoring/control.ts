/**
 * Shared control surface for the resource monitor *process* — the background OS
 * process whose entry point is `worker.ts`.
 *
 * Both the `assistant monitoring` CLI and the daemon lifecycle (when
 * `monitoring.enabled` is set) need to probe, spawn, and stop this process,
 * so the PID-file bookkeeping lives here in one place. Mirrors the memory
 * worker's `persistence/worker-control.ts`.
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

import { getConfig } from "../config/loader.js";
import { getCurrentLogFilePath, getLogger } from "../util/logger.js";
import { getMonitoringPidPath } from "../util/platform.js";

const log = getLogger("monitoring-control");

export interface MonitoringWorkerStatus {
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
 * Read the PID file and report liveness. A missing or malformed file reports
 * not_running; a file pointing at a dead process is cleaned up and reported as
 * not_running.
 */
export function probeMonitoringWorker(): MonitoringWorkerStatus {
  const path = getMonitoringPidPath();
  if (!existsSync(path)) return { status: "not_running" };

  const raw = readFileSync(path, "utf-8").trim();
  const pid = parseInt(raw, 10);
  if (!Number.isFinite(pid) || pid <= 0) return { status: "not_running" };

  try {
    process.kill(pid, 0);
    return { status: "running", pid };
  } catch (err: unknown) {
    if (isEsrchError(err)) {
      try {
        unlinkSync(path);
      } catch {
        // best-effort
      }
      return { status: "not_running" };
    }
    // Any other error (e.g. EPERM: the process exists but this caller may not
    // signal it) means the process is alive.
    return { status: "running", pid };
  }
}

export class MonitoringWorkerSpawnError extends Error {}

/**
 * How long {@link spawnMonitoringWorkerProcess} waits for the freshly-spawned
 * monitor to write its PID file before treating the spawn as failed. A cold
 * `bun run monitoring.ts` start — new runtime, config load — can take a
 * few seconds, so this is deliberately generous.
 */
const PID_FILE_WAIT_TIMEOUT_MS = 15_000;
const PID_FILE_POLL_INTERVAL_MS = 100;

export interface SpawnMonitoringWorkerOptions {
  pidWaitTimeoutMs?: number;
  pidPollIntervalMs?: number;
  /**
   * When the wait times out while the child is still alive, terminate it before
   * throwing so a monitor we report as failed cannot linger.
   */
  terminateOnTimeout?: boolean;
  /**
   * Process parentage (default `true`):
   *   - `true` — the monitor is its own session leader and outlives the spawning
   *     process. The short-lived CLI needs this so the monitor keeps running
   *     after the command returns.
   *   - `false` — the monitor is a direct child of the spawning process. The
   *     daemon passes this so the monitor it owns appears in its process tree
   *     (`assistant ps`) and is torn down with the daemon.
   */
  detached?: boolean;
}

type MonitorReadyOutcome = "ready" | "exited" | "timeout";

async function waitForPidFile(
  pidPath: string,
  exited: Promise<unknown> | undefined,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<MonitorReadyOutcome> {
  let childExited = false;
  const markExited = () => {
    childExited = true;
  };
  void exited?.then(markExited, markExited);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(pidPath)) return "ready";
    if (childExited) {
      return existsSync(pidPath) ? "ready" : "exited";
    }
    await Bun.sleep(pollIntervalMs);
  }
  return existsSync(pidPath) ? "ready" : "timeout";
}

/**
 * Spawn the resource monitor as a background process. If a monitor is already
 * running, returns its PID with `alreadyRunning: true` rather than spawning a
 * second one. Throws {@link MonitoringWorkerSpawnError} if the child crashes
 * during startup or never writes its PID file within the wait window.
 */
export async function spawnMonitoringWorkerProcess(
  opts: SpawnMonitoringWorkerOptions = {},
): Promise<{ pid: number; alreadyRunning: boolean }> {
  const pidWaitTimeoutMs = opts.pidWaitTimeoutMs ?? PID_FILE_WAIT_TIMEOUT_MS;
  const pidPollIntervalMs = opts.pidPollIntervalMs ?? PID_FILE_POLL_INTERVAL_MS;
  const detached = opts.detached ?? true;

  const current = probeMonitoringWorker();
  if (current.status === "running" && current.pid != null) {
    return { pid: current.pid, alreadyRunning: true };
  }

  const pidPath = getMonitoringPidPath();
  const entry = new URL("./worker.ts", import.meta.url);

  // Pipe the monitor's stderr into the same daily log file the daemon writes
  // to, so crash traces that bypass the in-process logger aren't lost.
  let stderrFd: number | "inherit" = "inherit";
  try {
    const logPath = getCurrentLogFilePath();
    mkdirSync(dirname(logPath), { recursive: true });
    stderrFd = openSync(logPath, "a", 0o600);
  } catch {
    // Fall back to inheriting the parent's stderr.
  }

  const child = Bun.spawn({
    cmd: ["bun", "run", entry.pathname],
    stdio: ["ignore", "ignore", stderrFd],
    detached,
  });

  if (typeof stderrFd === "number") {
    closeSync(stderrFd);
  }

  child.unref();

  const outcome = await waitForPidFile(
    pidPath,
    child.exited,
    pidWaitTimeoutMs,
    pidPollIntervalMs,
  );

  if (outcome !== "ready") {
    if (outcome === "timeout" && opts.terminateOnTimeout) {
      try {
        child.kill();
      } catch {
        // best-effort — the child may already be gone
      }
    }
    throw new MonitoringWorkerSpawnError(
      outcome === "exited"
        ? "Resource monitor exited during startup before writing its PID file"
        : `Resource monitor was spawned but did not write its PID file within ${Math.round(
            pidWaitTimeoutMs / 1000,
          )}s`,
    );
  }

  const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
  return { pid, alreadyRunning: false };
}

/**
 * Send SIGTERM to the monitor process if it is actually running. Returns the
 * status observed before signalling. Only throws if `process.kill` itself fails
 * (e.g. EPERM) — a not-running monitor is a no-op.
 */
export function stopMonitoringWorkerProcess(): MonitoringWorkerStatus {
  const current = probeMonitoringWorker();
  if (current.status === "running" && current.pid != null) {
    process.kill(current.pid, "SIGTERM");
  }
  return current;
}

/**
 * Daemon-lifecycle entry point: spawn the monitor as a child of the daemon
 * (`detached: false`, so it appears in `assistant ps` and is torn down on
 * shutdown) when `monitoring.enabled` is set. Fire-and-forget — a monitor
 * failure must never block boot.
 */
export function startMonitoring(): void {
  if (!getConfig().monitoring.enabled) return;
  void spawnMonitoringWorkerProcess({ detached: false })
    .then((r) =>
      log.info(
        { pid: r.pid, alreadyRunning: r.alreadyRunning },
        "Resource monitor started at boot",
      ),
    )
    .catch((err) =>
      log.warn({ err }, "Failed to start resource monitor at boot"),
    );
}

/**
 * Daemon-lifecycle entry point: SIGTERM the monitor process if it is running.
 * Keyed off live state rather than config: it may have been spawned at startup
 * or out of band via `assistant monitoring start`. Never throws.
 */
export function stopMonitoring(): void {
  try {
    const status = stopMonitoringWorkerProcess();
    if (status.status === "running") {
      log.info({ pid: status.pid }, "Sent SIGTERM to resource monitor process");
    }
  } catch (err) {
    log.warn({ err }, "Failed to stop resource monitor process (non-fatal)");
  }
}
