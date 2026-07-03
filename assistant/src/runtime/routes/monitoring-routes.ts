/**
 * Resource monitor control endpoints (start / stop / status).
 *
 * These run inside the daemon so the monitor process the daemon spawns is a
 * direct child of the daemon — which is what makes it show up in the daemon's
 * process tree (`assistant ps`) and lets the daemon tear it down on shutdown.
 * The `assistant monitoring` CLI is a thin IPC client over these routes.
 */

import { join } from "node:path";

import { z } from "zod";

import {
  getConfigReadOnly,
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
} from "../../config/loader.js";
import {
  MonitoringWorkerSpawnError,
  probeMonitoringWorker,
  spawnMonitoringWorkerProcess,
  stopMonitoringWorkerProcess,
} from "../../monitoring/control.js";
import type { ResourceSample } from "../../monitoring/resource-sampler.js";
import { SampleRingBuffer } from "../../monitoring/sample-ring-buffer.js";
import { getLogger } from "../../util/logger.js";
import {
  getMonitoringDataDir,
  getMonitoringPidPath,
} from "../../util/platform.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { InternalError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

const log = getLogger("monitoring-routes");

/**
 * Persist `monitoring.enabled` to the on-disk config via the shared
 * raw-config helpers, so only this leaf changes (schema defaults are not baked
 * into the file). The daemon re-reads config from disk, so the change takes
 * effect without a restart.
 */
function setMonitoringEnabled(enabled: boolean): void {
  const raw = loadRawConfig();
  setNestedValue(raw, "monitoring.enabled", enabled);
  saveRawConfig(raw);
}

const sampleMemorySchema = z.object({
  currentBytes: z.number(),
  limitBytes: z.number().nullable(),
  peakBytes: z.number().nullable(),
  ratio: z.number().nullable(),
});

const sampleDiskSchema = z.object({
  path: z.string(),
  usedMb: z.number(),
  totalMb: z.number(),
  freeMb: z.number(),
});

const sampleEventsSchema = z.object({
  low: z.number(),
  high: z.number(),
  max: z.number(),
  oom: z.number(),
  oomKill: z.number(),
});

const sampleMemoryStatSchema = z.object({
  anonBytes: z.number().nullable(),
  fileBytes: z.number().nullable(),
  kernelBytes: z.number().nullable(),
  slabReclaimableBytes: z.number().nullable(),
  slabUnreclaimableBytes: z.number().nullable(),
  unevictableBytes: z.number().nullable(),
  reclaimableBytes: z.number().nullable(),
});

const latestSampleSchema = z.object({
  ts: z.number(),
  memory: sampleMemorySchema.nullable(),
  memoryStat: sampleMemoryStatSchema.nullable(),
  events: sampleEventsSchema.nullable(),
  disk: sampleDiskSchema.nullable(),
});

const startResponseSchema = z.object({
  pid: z.number(),
  alreadyRunning: z.boolean(),
  monitoringEnabled: z.literal(true),
  pidPath: z.string(),
});

const stopResponseSchema = z.object({
  monitoringWasRunning: z.boolean(),
  pid: z.number().optional(),
  monitoringEnabled: z.literal(false),
});

const statusResponseSchema = z.object({
  status: z.enum(["running", "not_running"]),
  pid: z.number().optional(),
  monitoringEnabled: z.boolean(),
  dataDir: z.string(),
  latestSample: latestSampleSchema.nullable(),
});

/**
 * Start (or reuse) the resource monitor process as a child of the daemon, then
 * enable `monitoring.enabled` so it is respawned on the next boot. The
 * flag is only enabled once the monitor is confirmed up — on spawn failure it
 * is left untouched.
 */
async function handleMonitoringStart() {
  let result: { pid: number; alreadyRunning: boolean };
  try {
    // `detached: false` parents the monitor to the daemon so it appears in
    // `assistant ps` and is torn down on shutdown.
    result = await spawnMonitoringWorkerProcess({
      detached: false,
      terminateOnTimeout: true,
    });
  } catch (err) {
    const message =
      err instanceof MonitoringWorkerSpawnError || err instanceof Error
        ? err.message
        : String(err);
    log.warn({ err }, "Failed to start resource monitor process");
    throw new InternalError(message);
  }

  setMonitoringEnabled(true);

  return {
    pid: result.pid,
    alreadyRunning: result.alreadyRunning,
    monitoringEnabled: true as const,
    pidPath: getMonitoringPidPath(),
  };
}

/**
 * Disable `monitoring.enabled` and SIGTERM the monitor process if it is
 * running. A monitor that is not running is not an error.
 */
function handleMonitoringStop() {
  setMonitoringEnabled(false);

  let before: ReturnType<typeof stopMonitoringWorkerProcess>;
  try {
    before = stopMonitoringWorkerProcess();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err }, "Failed to signal resource monitor process");
    throw new InternalError(message);
  }

  return {
    monitoringWasRunning: before.status === "running",
    ...(before.pid != null ? { pid: before.pid } : {}),
    monitoringEnabled: false as const,
  };
}

/** Read the most recent persisted sample, or null if none exists yet. */
function readLatestSample(): ResourceSample | null {
  const config = getConfigReadOnly();
  try {
    const buffer = new SampleRingBuffer<ResourceSample>(
      join(getMonitoringDataDir(), "samples.jsonl"),
      config.monitoring.ringBufferSize,
    );
    return buffer.readLast();
  } catch (err) {
    log.warn({ err }, "Failed to read latest resource sample");
    return null;
  }
}

/**
 * Report the monitor process state, the `monitoring.enabled` config value,
 * and the most recent persisted sample so a caller can see live memory/disk
 * numbers without the monitor having to push anything.
 */
function handleMonitoringStatus() {
  const monitor = probeMonitoringWorker();
  const config = getConfigReadOnly();

  return {
    status: monitor.status,
    ...(monitor.pid != null ? { pid: monitor.pid } : {}),
    monitoringEnabled: config.monitoring.enabled,
    dataDir: getMonitoringDataDir(),
    latestSample: readLatestSample(),
  };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "monitoring_start",
    endpoint: "monitoring/start",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleMonitoringStart,
    summary: "Start the resource monitor",
    description:
      "Spawns (or reuses) the resource monitor process as a child of the daemon and enables monitoring.enabled.",
    tags: ["system"],
    responseBody: startResponseSchema,
  },
  {
    operationId: "monitoring_stop",
    endpoint: "monitoring/stop",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleMonitoringStop,
    summary: "Stop the resource monitor",
    description:
      "Disables monitoring.enabled and SIGTERMs the resource monitor process if it is running.",
    tags: ["system"],
    responseBody: stopResponseSchema,
  },
  {
    operationId: "monitoring_status",
    endpoint: "monitoring/status",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleMonitoringStatus,
    summary: "Resource monitor status",
    description:
      "Reports the resource monitor process state, monitoring.enabled, the forensics data directory, and the most recent persisted memory/disk sample.",
    tags: ["system"],
    responseBody: statusResponseSchema,
  },
];
