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

import { getConfigReadOnly } from "../../config/loader.js";
import {
  MonitoringWorkerSpawnError,
  probeMonitoringWorker,
  spawnMonitoringWorkerProcess,
  stopMonitoringWorkerProcess,
} from "../../monitoring/control.js";
import type { ResourceSample } from "../../monitoring/resource-sample-types.js";
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

const sampleReclaimSchema = z.object({
  pgscanDirect: z.number().nullable(),
  pgstealDirect: z.number().nullable(),
  workingsetRefaultFile: z.number().nullable(),
});

const sampleCpuSchema = z.object({
  usageUsec: z.number().nullable(),
  userUsec: z.number().nullable(),
  systemUsec: z.number().nullable(),
  nrPeriods: z.number().nullable(),
  nrThrottled: z.number().nullable(),
  throttledUsec: z.number().nullable(),
});

const sampleEventDeltasSchema = z.object({
  low: z.number().nullable(),
  high: z.number().nullable(),
  max: z.number().nullable(),
  oom: z.number().nullable(),
  oomKill: z.number().nullable(),
});

const sampleDeltasSchema = z.object({
  events: sampleEventDeltasSchema.nullable(),
  reclaim: sampleReclaimSchema.nullable(),
  cpu: sampleCpuSchema.nullable(),
});

const activeConversationSchema = z.object({
  conversationId: z.string(),
  title: z.string().nullable(),
  originChannel: z.string().nullable(),
  originInterface: z.string().nullable(),
  processingStartedAt: z.number(),
});

const latestSampleSchema = z.object({
  ts: z.number(),
  memory: sampleMemorySchema.nullable(),
  memoryStat: sampleMemoryStatSchema.nullable(),
  reclaim: sampleReclaimSchema.nullable(),
  cpu: sampleCpuSchema.nullable(),
  events: sampleEventsSchema.nullable(),
  deltas: sampleDeltasSchema.nullable(),
  disk: sampleDiskSchema.nullable(),
  activeConversations: z.array(activeConversationSchema).nullable(),
});

const startResponseSchema = z.object({
  pid: z.number(),
  alreadyRunning: z.boolean(),
  pidPath: z.string(),
});

const stopResponseSchema = z.object({
  monitoringWasRunning: z.boolean(),
  pid: z.number().optional(),
});

const statusResponseSchema = z.object({
  status: z.enum(["running", "not_running"]),
  pid: z.number().optional(),
  dataDir: z.string(),
  latestSample: latestSampleSchema.nullable(),
});

/**
 * Start (or reuse) the resource monitor process as a child of the daemon.
 * The daemon also spawns it at every boot, so this route exists to bring a
 * stopped monitor back up without a restart.
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

  return {
    pid: result.pid,
    alreadyRunning: result.alreadyRunning,
    pidPath: getMonitoringPidPath(),
  };
}

/**
 * SIGTERM the monitor process if it is running. A monitor that is not
 * running is not an error. The stop lasts until the next daemon boot, which
 * respawns the monitor unconditionally.
 */
function handleMonitoringStop() {
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
    const sample = buffer.readLast();
    if (sample == null) {
      return null;
    }
    // Samples persisted by an older monitor may predate some fields; fill
    // them with null so the response always matches the documented shape.
    return {
      ...sample,
      memoryStat: sample.memoryStat ?? null,
      reclaim: sample.reclaim ?? null,
      cpu: sample.cpu ?? null,
      deltas: sample.deltas ?? null,
      activeConversations: sample.activeConversations ?? null,
    };
  } catch (err) {
    log.warn({ err }, "Failed to read latest resource sample");
    return null;
  }
}

/**
 * Report the monitor process state and the most recent persisted sample so a
 * caller can see live memory/disk numbers without the monitor having to push
 * anything.
 */
function handleMonitoringStatus() {
  const monitor = probeMonitoringWorker();

  return {
    status: monitor.status,
    ...(monitor.pid != null ? { pid: monitor.pid } : {}),
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
      "Spawns (or reuses) the resource monitor process as a child of the daemon. The daemon also spawns it at every boot.",
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
      "SIGTERMs the resource monitor process if it is running. The monitor respawns on the next daemon boot.",
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
      "Reports the resource monitor process state, the forensics data directory, and the most recent persisted memory/disk sample.",
    tags: ["system"],
    responseBody: statusResponseSchema,
  },
];
