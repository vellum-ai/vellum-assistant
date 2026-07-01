/**
 * Shared control surface for the memory jobs worker *process* — the background
 * OS process whose entry point is `worker.ts`.
 *
 * Both the `assistant memory worker` CLI and the daemon lifecycle (when
 * `memory.worker.enabled` is set) need to probe, spawn, and stop this process.
 * The generic PID-file mechanics live in `util/worker-process.ts`; this module
 * binds them to the memory worker's PID path and entry point.
 */

import { getMemoryWorkerPidPath } from "../util/platform.js";
import {
  probeWorkerPidFile,
  spawnWorkerProcess,
  type SpawnWorkerProcessOptions,
  stopWorkerProcess,
  WorkerProcessSpawnError,
  type WorkerProcessStatus,
} from "../util/worker-process.js";

export type MemoryWorkerStatus = WorkerProcessStatus;

/**
 * Inspect the PID file to determine whether the worker process is alive.
 * A stale PID file (pointing at a dead process) is cleaned up and reported
 * as not_running.
 */
export function probeMemoryWorker(): MemoryWorkerStatus {
  return probeWorkerPidFile(getMemoryWorkerPidPath());
}

export class MemoryWorkerSpawnError extends WorkerProcessSpawnError {}

/**
 * Spawn options for the memory worker. Beyond the generic semantics
 * documented on {@link SpawnWorkerProcessOptions}, two flags carry
 * queue-ownership consequences specific to the memory worker:
 *
 *   - `terminateOnTimeout` — callers that leave `memory.worker.enabled` off
 *     on failure (the CLI `memory worker start`) MUST set this: otherwise the
 *     detached worker keeps coming up and drains the queue behind the
 *     daemon's still-active synchronous runner — two drainers racing on the
 *     same jobs. The daemon's own startup spawn leaves the flag on, so a late
 *     worker there becomes the sole drainer; it passes `false` to let that
 *     worker live.
 *   - `detached` — `true` for the short-lived CLI (the worker outlives the
 *     command); `false` for the daemon (the worker appears in `assistant ps`
 *     and is torn down with the daemon).
 */
export type SpawnMemoryWorkerOptions = SpawnWorkerProcessOptions;

/**
 * Spawn the memory worker as a background process. If a worker is already
 * running, returns its PID with `alreadyRunning: true` rather than spawning a
 * second one. Throws {@link MemoryWorkerSpawnError} if the child crashes
 * during startup or never writes its PID file within the wait window (i.e.
 * failed to start).
 */
export async function spawnMemoryWorkerProcess(
  opts: SpawnMemoryWorkerOptions = {},
): Promise<{
  pid: number;
  alreadyRunning: boolean;
}> {
  try {
    return await spawnWorkerProcess({
      pidPath: getMemoryWorkerPidPath(),
      entry: new URL("../jobs/worker.ts", import.meta.url),
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
export function stopMemoryWorkerProcess(): MemoryWorkerStatus {
  return stopWorkerProcess(getMemoryWorkerPidPath());
}
