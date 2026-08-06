/**
 * Route host worker control endpoints (start / stop / status).
 *
 * The route host runs user-defined `/x/*` handlers as a child process the
 * daemon spawns on demand (so it shows up in `assistant ps` and is torn down on
 * shutdown). These routes run inside the daemon so a worker spawned via them is
 * a direct child of the daemon too. `start` / `stop` manage the process
 * lifecycle directly (respawn or SIGTERM); `status` reports its liveness. The
 * `assistant routes worker` CLI is a thin IPC client over these routes.
 *
 * Unlike the schedule/monitor workers, the route host is NOT spawned at boot and
 * has no liveness watchdog — `RouteHostClient` respawns it lazily on the next
 * request — so there is no administratively-stopped flag to manage here.
 */

import { z } from "zod";

import {
  probeRouteHostWorker,
  RouteHostSpawnError,
  spawnRouteHostWorkerProcess,
  stopRouteHostWorkerProcess,
} from "../../routes/control.js";
import { ROUTE_HOST_PROC_NAME } from "../../routes/route-host-protocol.js";
import { getLogger } from "../../util/logger.js";
import { getProcPidPath } from "../../util/platform.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { InternalError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

const log = getLogger("route-host-worker-routes");

const startResponseSchema = z.object({
  pid: z.number(),
  alreadyRunning: z.boolean(),
  pidPath: z.string(),
});

const stopResponseSchema = z.object({
  workerWasRunning: z.boolean(),
  pid: z.number().optional(),
});

const statusResponseSchema = z.object({
  status: z.enum(["running", "not_running"]),
  pid: z.number().optional(),
});

/** Spawn (or reuse) the route host process as a child of the daemon. */
async function startRouteHostWorker() {
  let result: { pid: number; alreadyRunning: boolean };
  try {
    result = await spawnRouteHostWorkerProcess({ detached: false });
  } catch (err) {
    const message =
      err instanceof RouteHostSpawnError || err instanceof Error
        ? err.message
        : String(err);
    log.warn({ err }, "Failed to start route host process");
    throw new InternalError(message);
  }

  return {
    pid: result.pid,
    alreadyRunning: result.alreadyRunning,
    pidPath: getProcPidPath(ROUTE_HOST_PROC_NAME),
  };
}

/**
 * SIGTERM the route host process if it is running. A host that is not running
 * is not an error. The next `/x/*` request respawns it.
 */
function stopRouteHostWorker() {
  let before: ReturnType<typeof stopRouteHostWorkerProcess>;
  try {
    before = stopRouteHostWorkerProcess();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err }, "Failed to signal route host process");
    throw new InternalError(message);
  }

  return {
    workerWasRunning: before.status === "running",
    ...(before.pid != null ? { pid: before.pid } : {}),
  };
}

/** Report the route host process liveness from its PID file. */
function routeHostWorkerStatus() {
  const worker = probeRouteHostWorker();
  return {
    status: worker.status,
    ...(worker.pid != null ? { pid: worker.pid } : {}),
  };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "routes_worker_start",
    endpoint: "routes/worker/start",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: startRouteHostWorker,
    summary: "Start the route host",
    description:
      "Spawns (or reuses) the route host process as a child of the daemon.",
    tags: ["system"],
    responseBody: startResponseSchema,
  },
  {
    operationId: "routes_worker_stop",
    endpoint: "routes/worker/stop",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: stopRouteHostWorker,
    summary: "Stop the route host",
    description:
      "SIGTERMs the route host process if it is running; the next request respawns it.",
    tags: ["system"],
    responseBody: stopResponseSchema,
  },
  {
    operationId: "routes_worker_status",
    endpoint: "routes/worker/status",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: routeHostWorkerStatus,
    summary: "Route host status",
    description: "Reports the route host process liveness.",
    tags: ["system"],
    responseBody: statusResponseSchema,
  },
];
