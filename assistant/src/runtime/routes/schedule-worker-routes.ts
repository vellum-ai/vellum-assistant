/**
 * Schedule worker control endpoints (start / stop / status).
 *
 * The schedule worker runs as a child process the daemon spawns at startup (so
 * it shows up in `assistant ps` and is torn down on shutdown). These routes run
 * inside the daemon so a worker spawned on demand is a direct child of the
 * daemon too. `start` / `stop` manage the process lifecycle directly (respawn or
 * SIGTERM); `status` reports its liveness. The `assistant schedules worker` CLI
 * is a thin IPC client over these routes.
 */

import { z } from "zod";

import {
  probeScheduleWorker,
  ScheduleWorkerSpawnError,
  spawnScheduleWorkerProcess,
  stopScheduleWorkerProcess,
} from "../../schedule/worker-control.js";
import { getLogger } from "../../util/logger.js";
import { getScheduleWorkerPidPath } from "../../util/platform.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { InternalError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

const log = getLogger("schedule-worker-routes");

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

/**
 * Spawn (or reuse) the schedule worker process as a child of the daemon. The
 * worker is always the sole runner of schedule execution, so a worker that comes
 * up late is fine — `terminateOnTimeout` is not set.
 */
async function startScheduleWorker() {
  let result: { pid: number; alreadyRunning: boolean };
  try {
    result = await spawnScheduleWorkerProcess({ detached: false });
  } catch (err) {
    const message =
      err instanceof ScheduleWorkerSpawnError || err instanceof Error
        ? err.message
        : String(err);
    log.warn({ err }, "Failed to start schedule worker process");
    throw new InternalError(message);
  }

  return {
    pid: result.pid,
    alreadyRunning: result.alreadyRunning,
    pidPath: getScheduleWorkerPidPath(),
  };
}

/**
 * SIGTERM the schedule worker process if it is running. A worker that is not
 * running is not an error.
 */
function stopScheduleWorker() {
  let before: ReturnType<typeof stopScheduleWorkerProcess>;
  try {
    before = stopScheduleWorkerProcess();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err }, "Failed to signal schedule worker process");
    throw new InternalError(message);
  }

  return {
    workerWasRunning: before.status === "running",
    ...(before.pid != null ? { pid: before.pid } : {}),
  };
}

/** Report the schedule worker process liveness from its PID file. */
function scheduleWorkerStatus() {
  const worker = probeScheduleWorker();
  return {
    status: worker.status,
    ...(worker.pid != null ? { pid: worker.pid } : {}),
  };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "schedules_worker_start",
    endpoint: "schedules/worker/start",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: startScheduleWorker,
    summary: "Start the schedule worker",
    description:
      "Spawns (or reuses) the schedule worker process as a child of the daemon.",
    tags: ["system"],
    responseBody: startResponseSchema,
  },
  {
    operationId: "schedules_worker_stop",
    endpoint: "schedules/worker/stop",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: stopScheduleWorker,
    summary: "Stop the schedule worker",
    description: "SIGTERMs the schedule worker process if it is running.",
    tags: ["system"],
    responseBody: stopResponseSchema,
  },
  {
    operationId: "schedules_worker_status",
    endpoint: "schedules/worker/status",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: scheduleWorkerStatus,
    summary: "Schedule worker status",
    description: "Reports the schedule worker process liveness.",
    tags: ["system"],
    responseBody: statusResponseSchema,
  },
];
