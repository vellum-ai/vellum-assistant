/**
 * Process status endpoint (GET /v1/ps).
 *
 * Returns a JSON summary of the assistant's process tree so the CLI
 * (and platform UI) can render `vellum ps` without SSH or local process
 * detection.  The gateway probes the co-located daemon's health
 * endpoint and reports its own status implicitly (it's serving the
 * request).
 */

import { mintServiceToken } from "../../auth/token-exchange.js";
import type { GatewayConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";

const log = getLogger("ps");

interface ProcessEntry {
  name: string;
  status: "running" | "not_running" | "unreachable";
  children?: ProcessEntry[];
  info?: string;
}

interface PsResponse {
  processes: ProcessEntry[];
}

export function createPsHandler(config: GatewayConfig) {
  async function handlePs(): Promise<Response> {
    const assistantStatus = await probeAssistant(config);

    const processes: ProcessEntry[] = [
      {
        name: "assistant",
        status: assistantStatus,
        children: [
          { name: "qdrant", status: assistantStatus },
          { name: "embed-worker", status: assistantStatus },
        ],
      },
      {
        name: "gateway",
        status: "running",
        info: `port ${config.port}`,
      },
    ];

    const body: PsResponse = { processes };
    return Response.json(body);
  }

  return { handlePs };
}

async function probeAssistant(
  config: GatewayConfig,
): Promise<"running" | "not_running" | "unreachable"> {
  try {
    const url = `${config.assistantRuntimeBaseUrl}/v1/health`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${mintServiceToken()}`,
      },
    });

    clearTimeout(timeoutId);

    if (response.ok) return "running";

    log.warn({ status: response.status }, "Daemon health probe non-OK");
    return "not_running";
  } catch (err) {
    log.warn({ err }, "Daemon health probe failed");
    return "unreachable";
  }
}
