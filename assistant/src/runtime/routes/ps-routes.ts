/**
 * Daemon-side process status endpoint (GET /v1/ps).
 *
 * Reports the daemon's own process tree: the assistant runtime itself,
 * the qdrant vector store, and the embed worker.  Each sub-process
 * status is probed dynamically — qdrant via its /readyz HTTP endpoint,
 * embed-worker via PID-file liveness.
 */

import { existsSync, readFileSync } from "node:fs";

import { z } from "zod";

import { getConfig } from "../../config/loader.js";
import { resolveQdrantUrl } from "../../memory/qdrant-client.js";
import { getLogger } from "../../util/logger.js";
import { getEmbedWorkerPidPath } from "../../util/platform.js";
import type { RouteDefinition } from "./types.js";

const log = getLogger("ps-routes");

type ProcessStatus = "running" | "not_running" | "unreachable";

interface ProcessEntry {
  name: string;
  status: ProcessStatus;
  children?: ProcessEntry[];
  info?: string;
}

const processEntrySchema: z.ZodType<ProcessEntry> = z.lazy(() =>
  z.object({
    name: z.string(),
    status: z.enum(["running", "not_running", "unreachable"]),
    children: z.array(processEntrySchema).optional(),
    info: z.string().optional(),
  }),
);

const psResponseSchema = z.object({
  processes: z.array(processEntrySchema),
});

async function probeQdrant(): Promise<ProcessStatus> {
  try {
    const config = getConfig();
    const url = resolveQdrantUrl(config);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);

    const response = await fetch(`${url}/readyz`, {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    return response.ok ? "running" : "not_running";
  } catch (err) {
    log.debug({ err }, "Qdrant probe failed");
    return "unreachable";
  }
}

function probeEmbedWorker(): ProcessStatus {
  try {
    const pidPath = getEmbedWorkerPidPath();
    if (!existsSync(pidPath)) return "not_running";

    const raw = readFileSync(pidPath, "utf-8").trim();
    const pid = parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 0) return "not_running";

    process.kill(pid, 0);
    return "running";
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      err.code === "ESRCH"
    ) {
      return "not_running";
    }
    log.debug({ err }, "Embed worker probe failed");
    return "unreachable";
  }
}

async function getProcessStatus() {
  const [qdrantStatus, embedWorkerStatus] = await Promise.all([
    probeQdrant(),
    Promise.resolve(probeEmbedWorker()),
  ]);

  return {
    processes: [
      {
        name: "assistant",
        status: "running" as const,
        children: [
          { name: "qdrant", status: qdrantStatus },
          { name: "embed-worker", status: embedWorkerStatus },
        ],
      },
    ],
  };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "ps",
    endpoint: "ps",
    method: "GET",
    handler: getProcessStatus,
    summary: "Process status",
    description:
      "Returns a JSON summary of the assistant's process tree including qdrant and embed-worker status.",
    tags: ["system"],
    responseBody: psResponseSchema,
  },
];
