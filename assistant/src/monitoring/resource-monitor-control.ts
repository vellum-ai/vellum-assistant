/**
 * Shared control surface for the resource monitor *process* — the background OS
 * process whose entry point is `resource-monitor.ts`.
 *
 * Both the `assistant resource-monitor` CLI and the daemon lifecycle (when
 * `resourceMonitor.enabled` is set) need to probe, spawn, and stop this process,
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

import { getCurrentLogFilePath } from "../util/logger.js";
import { getResourceMonitorPidPath } from "../util/platform.js";

export interface ResourceMonitorStatus {
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
export function probeResourceMonitor(): ResourceMonitorStatus {
  const path = getResourceMonitorPidPath();
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

export class ResourceMonitorSpawnError extends Error {}

/**
 * How long {@link spawnResourceMonitorProcess} waits for the freshly-spawned
 * monitor to write its PID file before treating the spawn as failed. A cold
 * `bun run resource-monitor.ts` start — new runtime, config load — can take a
 * few seconds, so this is deliberately generous.
 */
const PID_FILE_WAIT_TIMEOUT_MS = 15_000;
const PID_FILE_POLL_INTERVAL_MS = 100;

export interface SpawnResourceMonitorOptions {
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
 * second one. Throws {@link ResourceMonitorSpawnError} if the child crashes
 * during startup or never writes its PID file within the wait window.
 */
export async function spawnResourceMonitorProcess(
  opts: SpawnResourceMonitorOptions = {},
): Promise<{ pid: number; alreadyRunning: boolean }> {
  const pidWaitTimeoutMs = opts.pidWaitTimeoutMs ?? PID_FILE_WAIT_TIMEOUT_MS;
  const pidPollIntervalMs = opts.pidPollIntervalMs ?? PID_FILE_POLL_INTERVAL_MS;
  const detached = opts.detached ?? true;

  const current = probeResourceMonitor();
  if (current.status === "running" && current.pid != null) {
    return { pid: current.pid, alreadyRunning: true };
  }

  const pidPath = getResourceMonitorPidPath();
  const entry = new URL("./resource-monitor.ts", import.meta.url);

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
    throw new ResourceMonitorSpawnError(
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
export function stopResourceMonitorProcess(): ResourceMonitorStatus {
  const current = probeResourceMonitor();
  if (current.status === "running" && current.pid != null) {
    process.kill(current.pid, "SIGTERM");
  }
  return current;
}
