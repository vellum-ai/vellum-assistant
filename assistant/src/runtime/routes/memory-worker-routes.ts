/**
 * Memory worker control endpoints (start / stop / status).
 *
 * The memory jobs worker runs as a child process the daemon spawns at startup
 * (so it shows up in `assistant ps` and is torn down on shutdown). These routes
 * run inside the daemon so a worker spawned on demand is a direct child of the
 * daemon too. `start` / `stop` manage the process lifecycle directly (respawn or
 * SIGTERM); `status` reports its liveness plus the resolved embedding-backend
 * status so a silent embedding-backend degradation — memory enqueues fine but
 * never embeds — is observable. The `assistant memory worker` CLI is a thin IPC
 * client over these routes.
 */

import { z } from "zod";

import { getConfigReadOnly } from "../../config/loader.js";
import { getMemoryBackendStatus } from "../../persistence/embeddings/embedding-backend.js";
import {
  MemoryWorkerSpawnError,
  probeMemoryWorker,
  spawnMemoryWorkerProcess,
  stopMemoryWorkerProcess,
} from "../../plugins/defaults/memory/worker-control.js";
import { getLogger } from "../../util/logger.js";
import { getMemoryWorkerPidPath } from "../../util/platform.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { InternalError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

const log = getLogger("memory-worker-routes");

export const embeddingStatusSchema = z.object({
  enabled: z.boolean(),
  degraded: z.boolean(),
  provider: z.enum(["local", "openai", "gemini", "ollama"]).nullable(),
  model: z.string().nullable(),
  reason: z.string().nullable(),
});

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
  embedding: embeddingStatusSchema,
});

/**
 * Spawn (or reuse) the memory worker process as a child of the daemon. The
 * worker is always the sole drainer of the memory job queue, so a worker that
 * comes up late is fine — `terminateOnTimeout` is not set.
 */
async function startMemoryWorker() {
  let result: { pid: number; alreadyRunning: boolean };
  try {
    result = await spawnMemoryWorkerProcess({ detached: false });
  } catch (err) {
    const message =
      err instanceof MemoryWorkerSpawnError || err instanceof Error
        ? err.message
        : String(err);
    log.warn({ err }, "Failed to start memory worker process");
    throw new InternalError(message);
  }

  return {
    pid: result.pid,
    alreadyRunning: result.alreadyRunning,
    pidPath: getMemoryWorkerPidPath(),
  };
}

/**
 * SIGTERM the memory worker process if it is running. A worker that is not
 * running is not an error.
 */
function stopMemoryWorker() {
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
  };
}

/**
 * Report the memory worker process liveness from its PID file, plus the
 * resolved embedding backend (or the degraded state when none resolves).
 */
async function memoryWorkerStatus() {
  const worker = probeMemoryWorker();
  const embedding = await getMemoryBackendStatus(getConfigReadOnly());

  return {
    status: worker.status,
    ...(worker.pid != null ? { pid: worker.pid } : {}),
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
      "Spawns (or reuses) the memory worker process as a child of the daemon.",
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
    description: "SIGTERMs the memory worker process if it is running.",
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
      "Reports the memory worker process liveness and the embedding-backend status (including a degraded flag and reason when no backend resolves).",
    tags: ["system"],
    responseBody: statusResponseSchema,
  },
];
