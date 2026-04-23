/**
 * Gateway proxy endpoints for the brain graph knowledge-graph visualizer.
 *
 * Exposes GET /v1/brain-graph and GET /v1/brain-graph-ui through the gateway
 * even when the broad runtime proxy is disabled.
 */

import { proxyForwardToResponse } from "@vellumai/assistant-client";

import { mintServiceToken } from "../../auth/token-exchange.js";
import type { GatewayConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";

const log = getLogger("brain-graph-proxy");

export function createBrainGraphProxyHandler(config: GatewayConfig) {
  async function proxyTo(req: Request, path: string): Promise<Response> {
    const start = performance.now();

    const response = await proxyForwardToResponse(req, {
      baseUrl: config.assistantRuntimeBaseUrl,
      path,
      serviceToken: mintServiceToken(),
      timeoutMs: config.runtimeTimeoutMs,
      fetchImpl,
    });

    const duration = Math.round(performance.now() - start);

    if (response.status >= 400) {
      log.warn(
        { status: response.status, duration, path },
        "Brain graph proxy upstream error",
      );
    } else {
      log.info(
        { status: response.status, duration, path },
        "Brain graph proxy completed",
      );
    }

    return response;
  }

  async function handleBrainGraph(req: Request): Promise<Response> {
    return proxyTo(req, "/v1/brain-graph");
  }

  async function handleBrainGraphUI(req: Request): Promise<Response> {
    return proxyTo(req, "/v1/brain-graph-ui");
  }

  return { handleBrainGraph, handleBrainGraphUI };
}
