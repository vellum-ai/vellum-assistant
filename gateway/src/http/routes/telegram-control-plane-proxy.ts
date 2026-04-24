/**
 * Gateway proxy endpoints for Telegram integration control-plane routes.
 *
 * These routes remain available even when the broad runtime proxy is
 * disabled, so skills and clients can use gateway URLs exclusively.
 */

import { proxyForward } from "@vellumai/assistant-client";

import { mintServiceToken } from "../../auth/token-exchange.js";
import type { GatewayConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";

const log = getLogger("telegram-control-plane-proxy");

export function createTelegramControlPlaneProxyHandler(config: GatewayConfig) {
  async function forward(
    req: Request,
    upstreamPath: string,
    upstreamSearch?: string,
  ): Promise<Response> {
    const start = performance.now();
    const result = await proxyForward(req, {
      baseUrl: config.assistantRuntimeBaseUrl,
      path: upstreamPath,
      search: upstreamSearch,
      serviceToken: mintServiceToken(),
      timeoutMs: config.runtimeTimeoutMs,
      fetchImpl,
    });

    const duration = Math.round(performance.now() - start);

    if (result.gatewayError) {
      log.error(
        { path: upstreamPath, duration },
        result.status === 504
          ? "Telegram control-plane proxy upstream timed out"
          : "Telegram control-plane proxy upstream connection failed",
      );
    } else if (result.status >= 400) {
      log.warn(
        { path: upstreamPath, status: result.status, duration },
        "Telegram control-plane proxy upstream error",
      );
    } else {
      log.info(
        { path: upstreamPath, status: result.status, duration },
        "Telegram control-plane proxy completed",
      );
    }

    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    });
  }

  return {
    async handleGetTelegramConfig(req: Request): Promise<Response> {
      return forward(req, "/v1/integrations/telegram/config");
    },

    async handleSetTelegramConfig(req: Request): Promise<Response> {
      return forward(req, "/v1/integrations/telegram/config");
    },

    async handleClearTelegramConfig(req: Request): Promise<Response> {
      return forward(req, "/v1/integrations/telegram/config");
    },

    async handleSetTelegramCommands(req: Request): Promise<Response> {
      return forward(req, "/v1/integrations/telegram/commands");
    },

    async handleSetupTelegram(req: Request): Promise<Response> {
      return forward(req, "/v1/integrations/telegram/setup");
    },
  };
}
