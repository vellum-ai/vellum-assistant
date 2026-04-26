/**
 * Gateway proxy endpoints for the brain graph knowledge-graph visualizer.
 *
 * Exposes GET /v1/brain-graph and GET /v1/brain-graph-ui through the gateway
 * even when the broad runtime proxy is disabled.
 *
 * The brain-graph-ui endpoint proxies plain HTML from the daemon and injects
 * an auth token meta tag before returning the page to the client. The daemon
 * has no knowledge of the token — the gateway owns the entire auth surface.
 *
 * Short-term approach: the gateway injects a `<meta name="api-token">` tag
 * into the proxied HTML. Longer-term, the brain-graph route should return
 * only JSON data so clients (which already have proper auth) render the UI
 * themselves, eliminating the need for embedded tokens entirely. See ATL-307.
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

    const html = await response.text();
    const token = mintUiPageToken();
    const escapedToken = token
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    const metaTag = `  <meta name="api-token" content="${escapedToken}">\n`;
    const injected = html.replace("</head>", `${metaTag}</head>`);

    const headers = new Headers(response.headers);
    headers.delete("content-length");

    return new Response(injected, {
      status: response.status,
      headers,
    });
  }

  return { handleBrainGraph, handleBrainGraphUI };
}
