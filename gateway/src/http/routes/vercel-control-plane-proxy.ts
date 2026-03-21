/**
 * Gateway proxy endpoints for Vercel integration control-plane routes.
 *
 * These routes forward GET/POST/DELETE requests for Vercel API token
 * management to the assistant runtime, ensuring all client traffic
 * goes through the gateway as required by AGENTS.md.
 */

import { mintServiceToken } from "../../auth/token-exchange.js";
import type { GatewayConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";
import { stripHopByHop } from "../../util/strip-hop-by-hop.js";

const log = getLogger("vercel-control-plane-proxy");

export function createVercelControlPlaneProxyHandler(config: GatewayConfig) {
  async function proxyToRuntime(
    req: Request,
    upstreamPath: string,
    upstreamSearch: string,
  ): Promise<Response> {
    const start = performance.now();
    const upstream = `${config.assistantRuntimeBaseUrl}${upstreamPath}${upstreamSearch}`;

    const reqHeaders = stripHopByHop(new Headers(req.headers));
    reqHeaders.delete("host");
    reqHeaders.delete("authorization");

    reqHeaders.set("authorization", `Bearer ${mintServiceToken()}`);

    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const bodyBuffer = hasBody ? await req.arrayBuffer() : null;
    if (bodyBuffer !== null) {
      reqHeaders.set("content-length", String(bodyBuffer.byteLength));
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort(
        new DOMException(
          "The operation was aborted due to timeout",
          "TimeoutError",
        ),
      );
    }, config.runtimeTimeoutMs);

    let response: Response;
    try {
      response = await fetchImpl(upstream, {
        method: req.method,
        headers: reqHeaders,
        body: bodyBuffer,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
    } catch (err) {
      clearTimeout(timeoutId);
      const duration = Math.round(performance.now() - start);
      if (err instanceof DOMException && err.name === "TimeoutError") {
        log.error(
          { path: upstreamPath, duration },
          "Vercel control-plane proxy upstream timed out",
        );
        return Response.json({ error: "Gateway Timeout" }, { status: 504 });
      }
      log.error(
        { err, path: upstreamPath, duration },
        "Vercel control-plane proxy upstream connection failed",
      );
      return Response.json({ error: "Bad Gateway" }, { status: 502 });
    }

    const resHeaders = stripHopByHop(new Headers(response.headers));
    const duration = Math.round(performance.now() - start);

    if (response.status >= 400) {
      const body = await response.text();
      log.warn(
        { path: upstreamPath, status: response.status, duration },
        "Vercel control-plane proxy upstream error",
      );
      return new Response(body, {
        status: response.status,
        headers: resHeaders,
      });
    }

    log.info(
      { path: upstreamPath, status: response.status, duration },
      "Vercel control-plane proxy completed",
    );
    return new Response(response.body, {
      status: response.status,
      headers: resHeaders,
    });
  }

  return {
    async handleGetVercelConfig(req: Request): Promise<Response> {
      return proxyToRuntime(req, "/v1/integrations/vercel/config", "");
    },

    async handleSetVercelConfig(req: Request): Promise<Response> {
      return proxyToRuntime(req, "/v1/integrations/vercel/config", "");
    },

    async handleDeleteVercelConfig(req: Request): Promise<Response> {
      return proxyToRuntime(req, "/v1/integrations/vercel/config", "");
    },
  };
}
