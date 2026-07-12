/**
 * Memory worker status endpoint.
 *
 * The memory jobs worker runs as a child process the daemon spawns at startup
 * (so it shows up in `assistant ps` and is torn down on shutdown). This
 * read-only route reports its liveness from the PID file, plus the resolved
 * embedding-backend status so a silent embedding-backend degradation — memory
 * enqueues fine but never embeds — is observable. The `assistant memory worker
 * status` CLI is a thin IPC client over it.
 */

import { z } from "zod";

import { getConfigReadOnly } from "../../config/loader.js";
import { getMemoryBackendStatus } from "../../persistence/embeddings/embedding-backend.js";
import { probeMemoryWorker } from "../../persistence/worker-control.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import type { RouteDefinition } from "./types.js";

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
  embedding: embeddingStatusSchema,
});

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
