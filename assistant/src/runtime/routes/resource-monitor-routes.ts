/**
 * Resource monitor control endpoints (start / stop / status).
 *
 * These run inside the daemon so the monitor process the daemon spawns is a
 * direct child of the daemon — which is what makes it show up in the daemon's
 * process tree (`assistant ps`) and lets the daemon tear it down on shutdown.
 * The `assistant resource-monitor` CLI is a thin IPC client over these routes.
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
  probeResourceMonitor,
  ResourceMonitorSpawnError,
  spawnResourceMonitorProcess,
  stopResourceMonitorProcess,
} from "../../monitoring/resource-monitor-control.js";
import type { ResourceSample } from "../../monitoring/resource-sampler.js";
import { SampleRingBuffer } from "../../monitoring/sample-ring-buffer.js";
import { getLogger } from "../../util/logger.js";
import {
  getResourceMonitorDataDir,
  getResourceMonitorPidPath,
} from "../../util/platform.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { InternalError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

const log = getLogger("resource-monitor-routes");

/**
 * Persist `resourceMonitor.enabled` to the on-disk config via the shared
 * raw-config helpers, so only this leaf changes (schema defaults are not baked
 * into the file). The daemon re-reads config from disk, so the change takes
 * effect without a restart.
 */
function setResourceMonitorEnabled(enabled: boolean): void {
  const raw = loadRawConfig();
  setNestedValue(raw, "resourceMonitor.enabled", enabled);
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

const latestSampleSchema = z.object({
  ts: z.number(),
  memory: sampleMemorySchema.nullable(),
  events: sampleEventsSchema.nullable(),
  disk: sampleDiskSchema.nullable(),
});

const startResponseSchema = z.object({
  pid: z.number(),
  alreadyRunning: z.boolean(),
  monitorEnabled: z.literal(true),
  pidPath: z.string(),
});

const stopResponseSchema = z.object({
  monitorWasRunning: z.boolean(),
  pid: z.number().optional(),
  monitorEnabled: z.literal(false),
});

const statusResponseSchema = z.object({
  status: z.enum(["running", "not_running"]),
  pid: z.number().optional(),
  monitorEnabled: z.boolean(),
  dataDir: z.string(),
  latestSample: latestSampleSchema.nullable(),
});

/**
 * Start (or reuse) the resource monitor process as a child of the daemon, then
 * enable `resourceMonitor.enabled` so it is respawned on the next boot. The
 * flag is only enabled once the monitor is confirmed up — on spawn failure it
 * is left untouched.
 */
async function startResourceMonitor() {
  let result: { pid: number; alreadyRunning: boolean };
  try {
    // `detached: false` parents the monitor to the daemon so it appears in
    // `assistant ps` and is torn down on shutdown.
    result = await spawnResourceMonitorProcess({
      detached: false,
      terminateOnTimeout: true,
    });
  } catch (err) {
    const message =
      err instanceof ResourceMonitorSpawnError || err instanceof Error
        ? err.message
        : String(err);
    log.warn({ err }, "Failed to start resource monitor process");
    throw new InternalError(message);
  }

  setResourceMonitorEnabled(true);

  return {
    pid: result.pid,
    alreadyRunning: result.alreadyRunning,
    monitorEnabled: true as const,
    pidPath: getResourceMonitorPidPath(),
  };
}

/**
 * Disable `resourceMonitor.enabled` and SIGTERM the monitor process if it is
 * running. A monitor that is not running is not an error.
 */
function stopResourceMonitor() {
  setResourceMonitorEnabled(false);

  let before: ReturnType<typeof stopResourceMonitorProcess>;
  try {
    before = stopResourceMonitorProcess();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err }, "Failed to signal resource monitor process");
    throw new InternalError(message);
  }

  return {
    monitorWasRunning: before.status === "running",
    ...(before.pid != null ? { pid: before.pid } : {}),
    monitorEnabled: false as const,
  };
}

/** Read the most recent persisted sample, or null if none exists yet. */
function readLatestSample(): ResourceSample | null {
  const config = getConfigReadOnly();
  try {
    const buffer = new SampleRingBuffer<ResourceSample>(
      join(getResourceMonitorDataDir(), "samples.jsonl"),
      config.resourceMonitor.ringBufferSize,
    );
    return buffer.readLast();
  } catch (err) {
    log.warn({ err }, "Failed to read latest resource sample");
    return null;
  }
}

/**
 * Report the monitor process state, the `resourceMonitor.enabled` config value,
 * and the most recent persisted sample so a caller can see live memory/disk
 * numbers without the monitor having to push anything.
 */
function resourceMonitorStatus() {
  const monitor = probeResourceMonitor();
  const config = getConfigReadOnly();

  return {
    status: monitor.status,
    ...(monitor.pid != null ? { pid: monitor.pid } : {}),
    monitorEnabled: config.resourceMonitor.enabled,
    dataDir: getResourceMonitorDataDir(),
    latestSample: readLatestSample(),
  };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "resource_monitor_start",
    endpoint: "resource-monitor/start",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: startResourceMonitor,
    summary: "Start the resource monitor",
    description:
      "Spawns (or reuses) the resource monitor process as a child of the daemon and enables resourceMonitor.enabled.",
    tags: ["system"],
    responseBody: startResponseSchema,
  },
  {
    operationId: "resource_monitor_stop",
    endpoint: "resource-monitor/stop",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: stopResourceMonitor,
    summary: "Stop the resource monitor",
    description:
      "Disables resourceMonitor.enabled and SIGTERMs the resource monitor process if it is running.",
    tags: ["system"],
    responseBody: stopResponseSchema,
  },
  {
    operationId: "resource_monitor_status",
    endpoint: "resource-monitor/status",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: resourceMonitorStatus,
    summary: "Resource monitor status",
    description:
      "Reports the resource monitor process state, resourceMonitor.enabled, the forensics data directory, and the most recent persisted memory/disk sample.",
    tags: ["system"],
    responseBody: statusResponseSchema,
  },
];
