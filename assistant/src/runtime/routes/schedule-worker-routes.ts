/**
 * Schedule worker control endpoints (start / stop / status).
 *
 * These run inside the daemon so the worker process the daemon spawns is a
 * direct child of the daemon — which is what makes it show up in the daemon's
 * process tree (`assistant ps`) and lets the daemon tear it down on shutdown.
 * The `assistant schedules worker` CLI is a thin IPC client over these routes;
 * if it spawned the worker itself, the worker would be parented to the
 * short-lived CLI process (reparented to init) instead of the daemon.
 */

import { z } from "zod";

import {
  getConfigReadOnly,
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
} from "../../config/loader.js";
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

/**
 * Persist `schedules.worker.enabled` to the on-disk config via the shared
 * raw-config helpers, so only this leaf changes (schema defaults are not baked
 * into the file). The daemon's scheduler re-reads the flag on its next tick,
 * so the change takes effect without a restart.
 */
function setScheduleWorkerEnabled(enabled: boolean): void {
  const raw = loadRawConfig();
  setNestedValue(raw, "schedules.worker.enabled", enabled);
  saveRawConfig(raw);
}

const workerStatusSchema = z.object({
  status: z.enum(["running", "not_running"]),
  pid: z.number().optional(),
});

const startResponseSchema = z.object({
  pid: z.number(),
  alreadyRunning: z.boolean(),
  workerEnabled: z.literal(true),
  pidPath: z.string(),
});

const stopResponseSchema = z.object({
  workerWasRunning: z.boolean(),
  pid: z.number().optional(),
  workerEnabled: z.literal(false),
});

const statusResponseSchema = z.object({
  status: z.enum(["running", "not_running"]),
  pid: z.number().optional(),
  workerEnabled: z.boolean(),
  inProcessScheduler: workerStatusSchema,
});

/**
 * Start (or reuse) the schedule worker process as a child of the daemon, then
 * enable `schedules.worker.enabled` so the daemon's scheduler leaves schedule
 * execution to it. The flag is only enabled once the worker is confirmed up —
 * on spawn failure it is left untouched so the in-process scheduler keeps
 * running schedules rather than standing down for a worker that never came
 * up.
 */
async function startScheduleWorker() {
  let result: { pid: number; alreadyRunning: boolean };
  try {
    // `detached: false` parents the worker to the daemon. `terminateOnTimeout`
    // matches the leave-the-flag-off-on-failure contract below: a worker that
    // came up late would otherwise run schedules alongside the in-process
    // scheduler.
    result = await spawnScheduleWorkerProcess({
      detached: false,
      terminateOnTimeout: true,
    });
  } catch (err) {
    const message =
      err instanceof ScheduleWorkerSpawnError || err instanceof Error
        ? err.message
        : String(err);
    log.warn({ err }, "Failed to start schedule worker process");
    throw new InternalError(message);
  }

  setScheduleWorkerEnabled(true);

  return {
    pid: result.pid,
    alreadyRunning: result.alreadyRunning,
    workerEnabled: true as const,
    pidPath: getScheduleWorkerPidPath(),
  };
}

/**
 * Disable `schedules.worker.enabled` (handing schedule execution back to the
 * in-process scheduler) and SIGTERM the worker process if it is running. A
 * worker that is not running is not an error — flipping the flag alone
 * restores in-process execution.
 */
function stopScheduleWorker() {
  setScheduleWorkerEnabled(false);

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
    workerEnabled: false as const,
  };
}

/**
 * Report the worker process state, the `schedules.worker.enabled` config
 * value, and whether the daemon's own scheduler is currently executing
 * schedules.
 *
 * The in-process scheduler executes schedules exactly when the flag is off
 * (it stands down from claiming while the flag is on). This handler runs
 * inside the daemon — the very process that is (or isn't) the in-process
 * scheduler — so its state is derived directly from config, with the
 * daemon's own PID, rather than read back from a marker file.
 */
function scheduleWorkerStatus() {
  const worker = probeScheduleWorker();
  const workerEnabled = getConfigReadOnly().schedules.worker.enabled;

  const inProcessScheduler: {
    status: "running" | "not_running";
    pid?: number;
  } = workerEnabled
    ? { status: "not_running" }
    : { status: "running", pid: process.pid };

  return {
    status: worker.status,
    ...(worker.pid != null ? { pid: worker.pid } : {}),
    workerEnabled,
    inProcessScheduler,
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
      "Spawns (or reuses) the schedule worker process as a child of the daemon and enables schedules.worker.enabled, so scheduled jobs run out of process.",
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
    description:
      "Disables schedules.worker.enabled (handing schedule execution back to the in-process scheduler) and SIGTERMs the schedule worker process if it is running.",
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
    description:
      "Reports the schedule worker process state, schedules.worker.enabled, and whether the daemon's in-process scheduler is currently executing schedules.",
    tags: ["system"],
    responseBody: statusResponseSchema,
  },
];
