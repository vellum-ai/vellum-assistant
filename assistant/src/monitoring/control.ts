/**
 * Shared control surface for the resource monitor *process* — the background OS
 * process whose entry point is `worker.ts`.
 *
 * Both the `assistant monitoring` CLI and the daemon lifecycle (which spawns
 * the monitor at every boot) need to probe, spawn, and stop this process.
 * The generic PID-file mechanics live in `util/worker-process.ts`; this module
 * binds them to the monitor's PID path and entry point.
 */

import { getLogger } from "../util/logger.js";
import { getMonitoringPidPath } from "../util/platform.js";
import {
  probeWorkerPidFile,
  spawnWorkerProcess,
  type SpawnWorkerProcessOptions,
  stopWorkerProcess,
  stopWorkerProcessAndWait,
  WorkerProcessSpawnError,
  type WorkerProcessStatus,
} from "../util/worker-process.js";

const log = getLogger("monitoring-control");

/**
 * Read the PID file and report liveness. A missing or malformed file reports
 * not_running; a file pointing at a dead process is cleaned up and reported as
 * not_running.
 */
export function probeMonitoringWorker(): WorkerProcessStatus {
  return probeWorkerPidFile(getMonitoringPidPath());
}

export class MonitoringWorkerSpawnError extends WorkerProcessSpawnError {}

/**
 * Spawn the resource monitor as a background process. If a monitor is already
 * running, returns its PID with `alreadyRunning: true` rather than spawning a
 * second one. Throws {@link MonitoringWorkerSpawnError} if the child crashes
 * during startup or never writes its PID file within the wait window.
 */
export async function spawnMonitoringWorkerProcess(
  opts: SpawnWorkerProcessOptions = {},
): Promise<{ pid: number; alreadyRunning: boolean }> {
  try {
    return await spawnWorkerProcess({
      pidPath: getMonitoringPidPath(),
      entry: new URL("./worker.ts", import.meta.url),
      packagedEntry: "monitoring",
      workerLabel: "Resource monitor",
      options: opts,
    });
  } catch (err) {
    if (err instanceof WorkerProcessSpawnError) {
      throw new MonitoringWorkerSpawnError(err.message);
    }
    throw err;
  }
}

/**
 * How long daemon shutdown waits for the resource monitor to exit after
 * SIGTERM. The monitor awaits in-flight workspace git add/commit on that
 * signal. This is a slice of the daemon's 30s force-exit budget; leftover
 * git is then serialized by the workspace repo lock.
 */
export const MONITOR_SHUTDOWN_WAIT_MS = 10_000;

/**
 * Send SIGTERM to the monitor process if it is actually running. Returns the
 * status observed before signalling. Only throws if `process.kill` itself fails
 * (e.g. EPERM) — a not-running monitor is a no-op.
 */
export function stopMonitoringWorkerProcess(): WorkerProcessStatus {
  return stopWorkerProcess(getMonitoringPidPath());
}

/**
 * SIGTERM the monitor and wait until it exits or `timeoutMs` elapses.
 * Never throws. Used on daemon shutdown so in-flight heartbeat git can
 * finish before this process flushes workspace commits.
 */
export async function stopMonitoringAndWait(
  timeoutMs: number = MONITOR_SHUTDOWN_WAIT_MS,
): Promise<void> {
  try {
    const result = await stopWorkerProcessAndWait(
      getMonitoringPidPath(),
      timeoutMs,
    );
    if (!result.signalled) {
      return;
    }
    if (result.exited) {
      log.info(
        { pid: result.pid },
        "Resource monitor process exited after SIGTERM",
      );
      return;
    }
    log.warn(
      { pid: result.pid, timeoutMs },
      "Resource monitor still running after SIGTERM wait; continuing shutdown",
    );
  } catch (err) {
    log.warn({ err }, "Failed to stop resource monitor process (non-fatal)");
  }
}

/**
 * Daemon-lifecycle entry point: spawn the monitor as a child of the daemon
 * (so it appears in the daemon's process tree and is torn down on
 * shutdown). Runs on every boot — the monitor is platform infrastructure,
 * not an opt-in feature. Fire-and-forget — a monitor failure must never
 * block boot.
 */
export function startMonitoring(): void {
  void spawnMonitoringWorkerProcess()
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
