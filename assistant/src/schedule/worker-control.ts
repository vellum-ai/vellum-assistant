/**
 * Shared control surface for the schedule worker *process* — the background OS
 * process whose entry point is `worker.ts`.
 *
 * Both the `assistant schedules worker` CLI and the daemon lifecycle (when
 * `schedules.worker.enabled` is set) need to probe, spawn, and stop this
 * process. The generic PID-file mechanics live in `util/worker-process.ts`;
 * this module binds them to the schedule worker's PID path and entry point.
 */

import { getConfig } from "../config/loader.js";
import { getLogger } from "../util/logger.js";
import { getScheduleWorkerPidPath } from "../util/platform.js";
import {
  probeWorkerPidFile,
  spawnWorkerProcess,
  type SpawnWorkerProcessOptions,
  stopWorkerProcess,
  WorkerProcessSpawnError,
  type WorkerProcessStatus,
} from "../util/worker-process.js";

const log = getLogger("schedule-worker-control");

export type ScheduleWorkerStatus = WorkerProcessStatus;

/**
 * Inspect the PID file to determine whether the schedule worker process is
 * alive. A stale PID file (pointing at a dead process) is cleaned up and
 * reported as not_running.
 */
export function probeScheduleWorker(): ScheduleWorkerStatus {
  return probeWorkerPidFile(getScheduleWorkerPidPath());
}

export class ScheduleWorkerSpawnError extends WorkerProcessSpawnError {}

/**
 * Spawn options for the schedule worker. Beyond the generic semantics
 * documented on {@link SpawnWorkerProcessOptions}: callers whose failure path
 * leaves `schedules.worker.enabled` off (the start route) should set
 * `terminateOnTimeout` so a worker reported as failed cannot come up later
 * and run script schedules alongside the daemon's scheduler; the daemon's
 * boot spawn leaves the flag on, so a late worker there is the desired sole
 * script runner and passes `false`.
 */
export type SpawnScheduleWorkerOptions = SpawnWorkerProcessOptions;

/**
 * Spawn the schedule worker as a background process. If a worker is already
 * running, returns its PID with `alreadyRunning: true` rather than spawning a
 * second one. Throws {@link ScheduleWorkerSpawnError} if the child crashes
 * during startup or never writes its PID file within the wait window.
 */
export async function spawnScheduleWorkerProcess(
  opts: SpawnScheduleWorkerOptions = {},
): Promise<{ pid: number; alreadyRunning: boolean }> {
  try {
    return await spawnWorkerProcess({
      pidPath: getScheduleWorkerPidPath(),
      entry: new URL("./worker.ts", import.meta.url),
      workerLabel: "Schedule worker",
      options: opts,
    });
  } catch (err) {
    if (err instanceof WorkerProcessSpawnError) {
      throw new ScheduleWorkerSpawnError(err.message);
    }
    throw err;
  }
}

/**
 * Send SIGTERM to the schedule worker process if it is actually running.
 * Returns the status observed before signalling. Only throws if
 * `process.kill` itself fails (e.g. EPERM) — a not-running worker is a no-op.
 */
export function stopScheduleWorkerProcess(): ScheduleWorkerStatus {
  return stopWorkerProcess(getScheduleWorkerPidPath());
}

/**
 * Daemon-lifecycle entry point: spawn the schedule worker as a child of the
 * daemon (`detached: false`, so it appears in `assistant ps` and is torn down
 * on shutdown) when `schedules.worker.enabled` is set. Fire-and-forget — a
 * worker failure must never block boot. The flag stays on either way, so a
 * worker that comes up late is the desired sole script runner
 * (`terminateOnTimeout` is deliberately not set).
 */
export function startScheduleWorkerIfEnabled(): void {
  if (getConfig().schedules?.worker?.enabled !== true) {
    return;
  }
  void spawnScheduleWorkerProcess({ detached: false })
    .then((r) =>
      log.info(
        { pid: r.pid, alreadyRunning: r.alreadyRunning },
        r.alreadyRunning
          ? "Schedule worker process already running — reusing it"
          : "Schedule worker process started at boot",
      ),
    )
    .catch((err) =>
      log.warn({ err }, "Failed to start schedule worker at boot"),
    );
}

/**
 * Daemon-lifecycle entry point: SIGTERM the schedule worker process if it is
 * running. Keyed off live state rather than config: it may have been spawned
 * at startup or out of band via `assistant schedules worker start`. Never
 * throws.
 */
export function stopScheduleWorker(): void {
  try {
    const status = stopScheduleWorkerProcess();
    if (status.status === "running") {
      log.info({ pid: status.pid }, "Sent SIGTERM to schedule worker process");
    }
  } catch (err) {
    log.warn({ err }, "Failed to stop schedule worker process (non-fatal)");
  }
}
