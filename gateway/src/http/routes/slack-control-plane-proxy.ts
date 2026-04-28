/**
 * Gateway proxy endpoints for Slack share control-plane routes.
 *
 * These routes remain available even when the broad runtime proxy is
 * disabled, so skills and clients can use gateway URLs exclusively.
 */

import { proxyForwardToResponse } from "@vellumai/assistant-client";

import { mintServiceToken } from "../../auth/token-exchange.js";
import type { GatewayConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";

const log = getLogger("slack-control-plane-proxy");

export function createSlackControlPlaneProxyHandler(config: GatewayConfig) {
  async function proxyToRuntime(
    req: Request,
    upstreamPath: string,
    upstreamSearch: string,
    options?: { timeoutMs?: number },
  ): Promise<Response> {
    const start = performance.now();
    const timeoutMs = options?.timeoutMs ?? config.runtimeTimeoutMs;
    const response = await proxyForwardToResponse(req, {
      baseUrl: config.assistantRuntimeBaseUrl,
      path: upstreamPath,
      search: upstreamSearch || undefined,
      serviceToken: mintServiceToken(),
      timeoutMs,
      fetchImpl,
    });
    const duration = Math.round(performance.now() - start);

    if (response.status >= 500) {
      log.error(
        { path: upstreamPath, status: response.status, duration },
        "Slack control-plane proxy upstream error",
      );
    } else if (response.status >= 400) {
      log.warn(
        { path: upstreamPath, status: response.status, duration },
        "Slack control-plane proxy upstream error",
      );
    } else {
      log.info(
        { path: upstreamPath, status: response.status, duration },
        "Slack control-plane proxy completed",
      );
    }

    return response;
  }

  return {
    async handleListSlackChannels(req: Request): Promise<Response> {
      const url = new URL(req.url);
      return proxyToRuntime(req, "/v1/slack/channels", url.search);
    },

    async handleShareToSlack(req: Request): Promise<Response> {
      return proxyToRuntime(req, "/v1/slack/share", "");
    },
  };
}
