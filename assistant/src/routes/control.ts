/**
 * Shared control surface for the route host *process* — the subprocess whose
 * entry point is `worker.ts`, which runs user-defined `/x/*` route handlers off
 * the daemon.
 *
 * The `assistant routes worker` CLI (via the `routes_worker_*` routes) needs to
 * probe, spawn, and stop this process. The generic PID-file mechanics live in
 * `util/worker-process.ts`; this module binds them to the route host's PID path
 * and entry point.
 *
 * Note the route host is spawned *on demand*, not at boot: {@link RouteHostClient}
 * also spawns it lazily on the first request. Both share the same PID file, so a
 * CLI-initiated `start` and a lazy spawn cooperate — whichever loses the race
 * sees `alreadyRunning`. Likewise `stop` is only a pause: the next request
 * respawns the host.
 */

import { getConfigReadOnly } from "../config/loader.js";
import { getLogger } from "../util/logger.js";
import { getProcPidPath } from "../util/platform.js";
import {
  probeWorkerPidFile,
  spawnWorkerProcess,
  type SpawnWorkerProcessOptions,
  stopWorkerProcess,
  WorkerProcessSpawnError,
  type WorkerProcessStatus,
} from "../util/worker-process.js";
import { ROUTE_HOST_PROC_NAME } from "./route-host-protocol.js";

const log = getLogger("route-host-control");

/**
 * Whether `/x/*` handlers should execute in the route host subprocess rather
 * than inline on the daemon's event loop. Read per-request so a `config.json`
 * edit (hot-reloaded by the config watcher) takes effect without a restart.
 */
export function isRouteHostEnabled(): boolean {
  return getConfigReadOnly().userRoutes.host.enabled;
}

function routeHostPidPath(): string {
  return getProcPidPath(ROUTE_HOST_PROC_NAME);
}

/**
 * Read the PID file and report liveness. A missing or malformed file reports
 * not_running; a file pointing at a dead process is cleaned up and reported as
 * not_running.
 */
export function probeRouteHostWorker(): WorkerProcessStatus {
  return probeWorkerPidFile(routeHostPidPath());
}

export class RouteHostSpawnError extends WorkerProcessSpawnError {}

/**
 * Spawn the route host as a background process. If one is already running,
 * returns its PID with `alreadyRunning: true` rather than spawning a second
 * one. Throws {@link RouteHostSpawnError} if the child crashes during startup or
 * never writes its PID file within the wait window.
 */
export async function spawnRouteHostWorkerProcess(
  opts: SpawnWorkerProcessOptions = {},
): Promise<{ pid: number; alreadyRunning: boolean }> {
  try {
    return await spawnWorkerProcess({
      pidPath: routeHostPidPath(),
      entry: new URL("./worker.ts", import.meta.url),
      workerLabel: "Route host",
      options: opts,
    });
  } catch (err) {
    if (err instanceof WorkerProcessSpawnError) {
      throw new RouteHostSpawnError(err.message);
    }
    throw err;
  }
}

/**
 * Send SIGTERM to the route host process if it is actually running. Returns the
 * status observed before signalling. Only throws if `process.kill` itself fails
 * (e.g. EPERM) — a not-running host is a no-op.
 */
export function stopRouteHostWorkerProcess(): WorkerProcessStatus {
  const status = probeRouteHostWorker();
  if (status.status === "running") {
    log.info({ pid: status.pid }, "Sending SIGTERM to route host process");
  }
  return stopWorkerProcess(routeHostPidPath());
}
