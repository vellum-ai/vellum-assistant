/**
 * Shared control surface for the memory jobs worker *process* — the background
 * OS process whose entry point is `worker.ts`.
 *
 * The daemon lifecycle spawns and stops this process, and the memory worker
 * status route probes it. The generic PID-file mechanics live in
 * `util/worker-process.ts`; this module binds them to the memory worker's PID
 * path and entry point.
 */

import { getMemoryWorkerPidPath } from "../../../util/platform.js";
import {
  probeWorkerPidFile,
  spawnWorkerProcess,
  type SpawnWorkerProcessOptions,
  stopWorkerProcess,
  WorkerProcessSpawnError,
  type WorkerProcessStatus,
} from "../../../util/worker-process.js";

/**
 * Inspect the PID file to determine whether the worker process is alive.
 * A stale PID file (pointing at a dead process) is cleaned up and reported
 * as not_running.
 */
export function probeMemoryWorker(): WorkerProcessStatus {
  return probeWorkerPidFile(getMemoryWorkerPidPath());
}

export class MemoryWorkerSpawnError extends WorkerProcessSpawnError {}

/**
 * Spawn the memory worker as a background process. If a worker is already
 * running, returns its PID with `alreadyRunning: true` rather than spawning a
 * second one. Throws {@link MemoryWorkerSpawnError} if the child crashes
 * during startup or never writes its PID file within the wait window (i.e.
 * failed to start).
 *
 * See {@link SpawnWorkerProcessOptions} for the generic option semantics. The
 * daemon's boot spawn passes `detached: false` (so the worker appears in
 * `assistant ps` and is torn down with the daemon) and leaves
 * `terminateOnTimeout` unset (a worker that comes up late is still the desired
 * sole drainer).
 */
export async function spawnMemoryWorkerProcess(
  opts: SpawnWorkerProcessOptions = {},
): Promise<{
  pid: number;
  alreadyRunning: boolean;
}> {
  try {
    return await spawnWorkerProcess({
      pidPath: getMemoryWorkerPidPath(),
      entry: new URL("../plugins/defaults/memory/worker.ts", import.meta.url),
      workerLabel: "Memory worker",
      options: opts,
    });
  } catch (err) {
    if (err instanceof WorkerProcessSpawnError) {
      throw new MemoryWorkerSpawnError(err.message);
    }
    throw err;
  }
}

/**
 * Send SIGTERM to the worker process if it is actually running.
 *
 * Returns the status observed before signalling, so callers can report
 * whether anything was stopped. Only throws if `process.kill` itself fails
 * (e.g. EPERM) — a not-running worker is a no-op.
 */
export function stopMemoryWorkerProcess(): WorkerProcessStatus {
  return stopWorkerProcess(getMemoryWorkerPidPath());
}
