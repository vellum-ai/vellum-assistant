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
 * True when an operator explicitly stopped the worker (via
 * `assistant schedules worker stop`). The liveness watchdog must not respawn it
 * while this is set, or a manual stop would be silently undone within one tick.
 * Process-local: it resets to false on daemon restart and is cleared by the
 * `schedules worker start` route — a restart is treated as a fresh start.
 */
let administrativelyStopped = false;

/** Whether the schedule worker has been administratively stopped by an operator. */
export function isScheduleWorkerAdministrativelyStopped(): boolean {
  return administrativelyStopped;
}

/** Set/clear the administratively-stopped flag (set by stop, cleared by start). */
export function setScheduleWorkerAdministrativelyStopped(value: boolean): void {
  administrativelyStopped = value;
}

/**
 * Inspect the PID file to determine whether the schedule worker process is
 * alive. A stale PID file (pointing at a dead process) is cleaned up and
 * reported as not_running.
 */
export function probeScheduleWorker(): WorkerProcessStatus {
  return probeWorkerPidFile(getScheduleWorkerPidPath());
}

export class ScheduleWorkerSpawnError extends WorkerProcessSpawnError {}

/** The single in-flight spawn attempt, or null when none is running. */
let inFlightSpawn: Promise<{ pid: number; alreadyRunning: boolean }> | null =
  null;

/**
 * Spawn the schedule worker as a background process. If a worker is already
 * running, returns its PID with `alreadyRunning: true` rather than spawning a
 * second one. Throws {@link ScheduleWorkerSpawnError} if the child crashes
 * during startup or never writes its PID file within the wait window.
 *
 * Concurrent calls coalesce onto one in-flight spawn. The daemon's boot spawn
 * and the liveness watchdog's first tick both run before a cold worker has
 * written its PID file, so `spawnWorkerProcess`'s PID-file guard cannot see the
 * sibling spawn; without this latch each would start a worker — double schedule
 * execution plus an orphan on shutdown. Coalesced callers report
 * `alreadyRunning: true`, so the watchdog logs no spurious respawn.
 *
 * See {@link SpawnWorkerProcessOptions} for the generic option semantics. The
 * daemon's boot spawn leaves `terminateOnTimeout` unset: a worker that comes up
 * late is still the desired sole schedule runner.
 */
export async function spawnScheduleWorkerProcess(
  opts: SpawnWorkerProcessOptions = {},
): Promise<{ pid: number; alreadyRunning: boolean }> {
  const existing = inFlightSpawn;
  if (existing) {
    const { pid } = await existing;
    return { pid, alreadyRunning: true };
  }
  const spawn = spawnScheduleWorkerProcessUncoalesced(opts);
  inFlightSpawn = spawn;
  try {
    return await spawn;
  } finally {
    inFlightSpawn = null;
  }
}

async function spawnScheduleWorkerProcessUncoalesced(
  opts: SpawnWorkerProcessOptions,
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
