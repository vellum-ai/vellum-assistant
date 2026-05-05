/**
 * Gateway proxy endpoint for runtime health checks.
 *
 * Exposes GET /v1/health as a dedicated gateway route with explicit
 * auth handling.
 */

import { proxyForwardToResponse } from "@vellumai/assistant-client";

import { mintServiceToken } from "../../auth/token-exchange.js";
import type { GatewayConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";

const log = getLogger("runtime-health-proxy");

export function createRuntimeHealthProxyHandler(config: GatewayConfig) {
  async function handleRuntimeHealth(req: Request): Promise<Response> {
    const start = performance.now();
    const response = await proxyForwardToResponse(req, {
      baseUrl: config.assistantRuntimeBaseUrl,
      path: "/v1/health",
      serviceToken: mintServiceToken(),
      timeoutMs: config.runtimeTimeoutMs,
      fetchImpl,
    });
    const duration = Math.round(performance.now() - start);

    if (response.status >= 500) {
      log.error(
        { status: response.status, duration },
        "Runtime health proxy upstream error",
      );
    } else if (response.status >= 400) {
      log.warn(
        { status: response.status, duration },
        "Runtime health proxy upstream error",
      );
    } else {
      log.info(
        { status: response.status, duration },
        "Runtime health proxy completed",
      );
    }

    return response;
  }

  return { handleRuntimeHealth };
}
