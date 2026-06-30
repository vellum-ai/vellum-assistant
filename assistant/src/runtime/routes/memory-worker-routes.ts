/**
 * Memory worker control endpoints (start / stop / status).
 *
 * These run inside the daemon so the worker process the daemon spawns is a
 * direct child of the daemon — which is what makes it show up in the daemon's
 * process tree (`assistant ps`) and lets the daemon tear it down on shutdown.
 * The `assistant memory worker` CLI is a thin IPC client over these routes; if
 * it spawned the worker itself, the worker would be parented to the short-lived
 * CLI process (reparented to init) instead of the daemon.
 */

import { z } from "zod";

import {
  getConfigReadOnly,
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
} from "../../config/loader.js";
import { getMemoryBackendStatus } from "../../persistence/embeddings/embedding-backend.js";
import {
  MemoryWorkerSpawnError,
  probeMemoryWorker,
  spawnMemoryWorkerProcess,
  stopMemoryWorkerProcess,
} from "../../persistence/worker-control.js";
import { getLogger } from "../../util/logger.js";
import { getMemoryWorkerPidPath } from "../../util/platform.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { InternalError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

const log = getLogger("memory-worker-routes");

/**
 * Persist `memory.worker.enabled` to the on-disk config via the shared
 * raw-config helpers, so only this leaf changes (schema defaults are not baked
 * into the file). The daemon's worker supervisor re-reads the flag from disk on
 * its next poll, so the change takes effect without a restart.
 */
function setMemoryWorkerEnabled(enabled: boolean): void {
  const raw = loadRawConfig();
  setNestedValue(raw, "memory.worker.enabled", enabled);
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

export const embeddingStatusSchema = z.object({
  enabled: z.boolean(),
  degraded: z.boolean(),
  provider: z.enum(["local", "openai", "gemini", "ollama"]).nullable(),
  model: z.string().nullable(),
  reason: z.string().nullable(),
});

const statusResponseSchema = z.object({
  status: z.enum(["running", "not_running"]),
  pid: z.number().optional(),
  workerEnabled: z.boolean(),
  syncRunner: workerStatusSchema,
  embedding: embeddingStatusSchema,
});

/**
 * Start (or reuse) the memory worker process as a child of the daemon, then
 * enable `memory.worker.enabled` so the daemon's supervisor stands its
 * synchronous in-process runner down. The flag is only enabled once the worker
 * is confirmed up — on spawn failure it is left untouched so the synchronous
 * runner keeps draining the queue rather than standing down for a worker that
 * never came up.
 */
async function startMemoryWorker() {
  let result: { pid: number; alreadyRunning: boolean };
  try {
    // `detached: false` parents the worker to the daemon. `terminateOnTimeout`
    // matches the leave-the-flag-off-on-failure contract below: a worker that
    // came up late would otherwise drain the queue alongside the synchronous
    // runner.
    result = await spawnMemoryWorkerProcess({
      detached: false,
      terminateOnTimeout: true,
    });
  } catch (err) {
    const message =
      err instanceof MemoryWorkerSpawnError || err instanceof Error
        ? err.message
        : String(err);
    log.warn({ err }, "Failed to start memory worker process");
    throw new InternalError(message);
  }

  setMemoryWorkerEnabled(true);

  return {
    pid: result.pid,
    alreadyRunning: result.alreadyRunning,
    workerEnabled: true as const,
    pidPath: getMemoryWorkerPidPath(),
  };
}

/**
 * Disable `memory.worker.enabled` (handing the queue back to the synchronous
 * in-process runner) and SIGTERM the worker process if it is running. A worker
 * that is not running is not an error — flipping the flag alone restores
 * synchronous mode.
 */
function stopMemoryWorker() {
  setMemoryWorkerEnabled(false);

  let before: ReturnType<typeof stopMemoryWorkerProcess>;
  try {
    before = stopMemoryWorkerProcess();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err }, "Failed to signal memory worker process");
    throw new InternalError(message);
  }

  return {
    workerWasRunning: before.status === "running",
    ...(before.pid != null ? { pid: before.pid } : {}),
    workerEnabled: false as const,
  };
}

/**
 * Report the worker process state, the `memory.worker.enabled` config value,
 * and whether the daemon's synchronous in-process runner is currently draining
 * the queue.
 *
 * The supervisor drains in-process exactly when memory is enabled and the
 * out-of-process worker is not (it stands down on `memory.worker.enabled`).
 * This handler runs inside the daemon — the very process that is (or isn't) the
 * synchronous runner — so the runner's state is derived directly from config,
 * with the daemon's own PID, rather than read back from a marker file.
 *
 * The `embedding` block reports the resolved embedding backend (or the
 * degraded state when none resolves), so a silent embedding-backend
 * degradation — memory enqueues fine but never embeds — is observable.
 */
async function memoryWorkerStatus() {
  const worker = probeMemoryWorker();
  const config = getConfigReadOnly();
  const workerEnabled = config.memory.worker.enabled;

  const syncRunnerActive = config.memory.enabled !== false && !workerEnabled;
  const syncRunner: { status: "running" | "not_running"; pid?: number } =
    syncRunnerActive
      ? { status: "running", pid: process.pid }
      : { status: "not_running" };

  const embedding = await getMemoryBackendStatus(config);

  return {
    status: worker.status,
    ...(worker.pid != null ? { pid: worker.pid } : {}),
    workerEnabled,
    syncRunner,
    embedding,
  };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "memory_worker_start",
    endpoint: "memory/worker/start",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: startMemoryWorker,
    summary: "Start the memory worker",
    description:
      "Spawns (or reuses) the memory worker process as a child of the daemon and enables memory.worker.enabled.",
    tags: ["system"],
    responseBody: startResponseSchema,
  },
  {
    operationId: "memory_worker_stop",
    endpoint: "memory/worker/stop",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: stopMemoryWorker,
    summary: "Stop the memory worker",
    description:
      "Disables memory.worker.enabled and SIGTERMs the memory worker process if it is running.",
    tags: ["system"],
    responseBody: stopResponseSchema,
  },
  {
    operationId: "memory_worker_status",
    endpoint: "memory/worker/status",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: memoryWorkerStatus,
    summary: "Memory worker status",
    description:
      "Reports the memory worker process state, memory.worker.enabled, the synchronous in-process runner, and the embedding-backend status (including a degraded flag and reason when no backend resolves).",
    tags: ["system"],
    responseBody: statusResponseSchema,
  },
];
