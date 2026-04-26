/**
 * Gateway proxy endpoints for the brain graph knowledge-graph visualizer.
 *
 * Exposes GET /v1/brain-graph and GET /v1/brain-graph-ui through the gateway
 * even when the broad runtime proxy is disabled.
 *
 * The brain-graph-ui endpoint proxies HTML from the daemon that contains a
 * sentinel placeholder for the auth token. The gateway replaces the placeholder
 * with a freshly minted JWT before returning the page to the client.
 */

import { proxyForwardToResponse } from "@vellumai/assistant-client";

import {
  mintServiceToken,
  mintUiPageToken,
} from "../../auth/token-exchange.js";
import type { GatewayConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";

const log = getLogger("brain-graph-proxy");

const UI_PAGE_TOKEN_PLACEHOLDER = "__VELLUM_UI_PAGE_TOKEN__";

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
    const response = await proxyTo(req, "/v1/brain-graph-ui");
    if (!response.ok) return response;

    const body = await response.text();
    const injected = body.replaceAll(
      UI_PAGE_TOKEN_PLACEHOLDER,
      mintUiPageToken(),
    );

    return new Response(injected, {
      status: response.status,
      headers: response.headers,
    });
  }

  return { handleBrainGraph, handleBrainGraphUI };
}
