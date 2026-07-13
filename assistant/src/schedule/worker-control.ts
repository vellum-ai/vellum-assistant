/**
 * Shared control surface for the schedule worker *process* — the background OS
 * process whose entry point is `worker.ts`.
 *
 * The daemon lifecycle spawns and stops this process, and the schedule worker
 * status route probes it. The generic PID-file mechanics live in
 * `util/worker-process.ts`; this module binds them to the schedule worker's PID
 * path and entry point.
 */

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

/**
 * Inspect the PID file to determine whether the schedule worker process is
 * alive. A stale PID file (pointing at a dead process) is cleaned up and
 * reported as not_running.
 */
export function probeScheduleWorker(): WorkerProcessStatus {
  return probeWorkerPidFile(getScheduleWorkerPidPath());
}

export class ScheduleWorkerSpawnError extends WorkerProcessSpawnError {}

/**
 * Spawn the schedule worker as a background process. If a worker is already
 * running, returns its PID with `alreadyRunning: true` rather than spawning a
 * second one. Throws {@link ScheduleWorkerSpawnError} if the child crashes
 * during startup or never writes its PID file within the wait window.
 *
 * See {@link SpawnWorkerProcessOptions} for the generic option semantics. The
 * daemon's boot spawn leaves `terminateOnTimeout` unset: a worker that comes up
 * late is still the desired sole schedule runner.
 */
export async function spawnScheduleWorkerProcess(
  opts: SpawnWorkerProcessOptions = {},
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
export function stopScheduleWorkerProcess(): WorkerProcessStatus {
  return stopWorkerProcess(getScheduleWorkerPidPath());
}

/**
 * Daemon-lifecycle entry point: spawn the schedule worker as a child of the
 * daemon (`detached: false`, so it appears in `assistant ps` and is torn down
 * on shutdown). Fire-and-forget — a worker failure must never block boot. A
 * worker that comes up late is still the desired sole schedule runner
 * (`terminateOnTimeout` is deliberately not set).
 */
export function startScheduleWorker(): void {
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
 * running. Keyed off live state (the PID file) rather than config. Never
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
