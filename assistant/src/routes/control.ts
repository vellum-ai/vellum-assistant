/**
 * Shared control surface for the route host *process* — the subprocess whose
 * entry point is `worker.ts`, which runs user-defined `/x/*` route handlers off
 * the daemon.
 *
 * The daemon lifecycle ({@link startRouteHost} / {@link stopRouteHost}) and the
 * `assistant routes worker` CLI (via the `routes_worker_*` routes) both need to
 * probe, spawn, and stop this process. The generic PID-file mechanics live in
 * `util/worker-process.ts`; this module binds them to the route host's PID path
 * and entry point.
 *
 * The host may be brought up three ways, all sharing one PID file so they
 * cooperate (whoever loses a race sees `alreadyRunning`): pre-warmed at boot
 * when enabled ({@link startRouteHost}), started via the CLI, or lazily on the
 * first request ({@link RouteHostClient}). A `stop` is only a pause — the next
 * request respawns it.
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
  return stopWorkerProcess(routeHostPidPath());
}

/**
 * Daemon-lifecycle entry point: pre-warm the route host at boot, as a child of
 * the daemon (so it appears in `assistant ps` and is torn down on shutdown).
 *
 * Only when enabled — the host is opt-in, so a disabled config is a no-op here
 * (a request lazily spawns it if the flag is flipped on at runtime). Runs
 * fire-and-forget: a spawn failure must never block boot.
 */
export function startRouteHost(): void {
  if (!isRouteHostEnabled()) {
    return;
  }
  void spawnRouteHostWorkerProcess({ detached: false })
    .then((r) =>
      log.info(
        { pid: r.pid, alreadyRunning: r.alreadyRunning },
        "Route host started at boot",
      ),
    )
    .catch((err) => log.warn({ err }, "Failed to start route host at boot"));
}

/**
 * Daemon-lifecycle entry point: SIGTERM the route host if it is running. Keyed
 * off live state, not config — the host may have been spawned at boot, via
 * `assistant routes worker start`, or lazily on a request. Never throws.
 */
export function stopRouteHost(): void {
  try {
    const status = stopRouteHostWorkerProcess();
    if (status.status === "running") {
      log.info({ pid: status.pid }, "Sent SIGTERM to route host process");
    }
  } catch (err) {
    log.warn({ err }, "Failed to stop route host process (non-fatal)");
  }
}
