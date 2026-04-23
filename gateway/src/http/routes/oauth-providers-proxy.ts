/**
 * Gateway proxy endpoints for OAuth provider discovery routes.
 *
 * These routes remain available even when the broad runtime proxy is
 * disabled, so skills and clients can use gateway URLs exclusively.
 */

import { proxyForwardToResponse } from "@vellumai/assistant-client";

import { mintServiceToken } from "../../auth/token-exchange.js";
import type { GatewayConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";

const log = getLogger("oauth-providers-proxy");

export function createOAuthProvidersProxyHandler(config: GatewayConfig) {
  async function proxyToRuntime(
    req: Request,
    upstreamPath: string,
    upstreamSearch: string,
  ): Promise<Response> {
    const start = performance.now();
    const response = await proxyForwardToResponse(req, {
      baseUrl: config.assistantRuntimeBaseUrl,
      path: upstreamPath,
      search: upstreamSearch || undefined,
      serviceToken: mintServiceToken(),
      timeoutMs: config.runtimeTimeoutMs,
      fetchImpl,
    });
    const duration = Math.round(performance.now() - start);

    if (response.status >= 500) {
      log.error(
        { path: upstreamPath, status: response.status, duration },
        "OAuth providers proxy upstream error",
      );
    } else if (response.status >= 400) {
      log.warn(
        { path: upstreamPath, status: response.status, duration },
        "OAuth providers proxy upstream error",
      );
    } else {
      log.info(
        { path: upstreamPath, status: response.status, duration },
        "OAuth providers proxy completed",
      );
    }

    return response;
  }

  return {
    async handleListProviders(req: Request): Promise<Response> {
      return proxyToRuntime(
        req,
        "/v1/oauth/providers",
        new URL(req.url).search,
      );
    },

    async handleGetProvider(
      req: Request,
      providerKey: string,
    ): Promise<Response> {
      return proxyToRuntime(req, `/v1/oauth/providers/${providerKey}`, "");
    },
  };
}
