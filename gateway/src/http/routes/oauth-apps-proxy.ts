/**
 * Gateway proxy endpoints for OAuth app and connection management routes.
 *
 * These routes are registered as explicit gateway routes for dedicated
 * auth handling rather than falling through to the catch-all proxy.
 */

import { proxyForwardToResponse } from "@vellumai/assistant-client";

import { mintServiceToken } from "../../auth/token-exchange.js";
import type { GatewayConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";

const log = getLogger("oauth-apps-proxy");

export function createOAuthAppsProxyHandler(config: GatewayConfig) {
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
        "OAuth apps proxy upstream error",
      );
    } else if (response.status >= 400) {
      log.warn(
        { path: upstreamPath, status: response.status, duration },
        "OAuth apps proxy upstream error",
      );
    } else {
      log.info(
        { path: upstreamPath, status: response.status, duration },
        "OAuth apps proxy completed",
      );
    }

    return response;
  }

  return {
    async handleListApps(req: Request): Promise<Response> {
      return proxyToRuntime(req, "/v1/oauth/apps", new URL(req.url).search);
    },

    async handleCreateApp(req: Request): Promise<Response> {
      return proxyToRuntime(req, "/v1/oauth/apps", "");
    },

    async handleDeleteApp(req: Request, appId: string): Promise<Response> {
      return proxyToRuntime(req, `/v1/oauth/apps/${appId}`, "");
    },

    async handleListConnections(
      req: Request,
      appId: string,
    ): Promise<Response> {
      return proxyToRuntime(req, `/v1/oauth/apps/${appId}/connections`, "");
    },

    async handleDeleteConnection(
      req: Request,
      connectionId: string,
    ): Promise<Response> {
      return proxyToRuntime(req, `/v1/oauth/connections/${connectionId}`, "");
    },

    async handleConnect(req: Request, appId: string): Promise<Response> {
      return proxyToRuntime(req, `/v1/oauth/apps/${appId}/connect`, "");
    },
  };
}
