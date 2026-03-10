/**
 * Gateway proxy endpoints for the brain graph knowledge-graph visualizer.
 *
 * Exposes GET /v1/brain-graph and GET /v1/brain-graph-ui through the gateway
 * even when the broad runtime proxy is disabled.
 */

import { mintServiceToken } from "../../auth/token-exchange.js";
import type { GatewayConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";
import { stripHopByHop } from "../../util/strip-hop-by-hop.js";

const log = getLogger("brain-graph-proxy");

export function createBrainGraphProxyHandler(config: GatewayConfig) {
  async function proxyTo(req: Request, upstream: string): Promise<Response> {
    const start = performance.now();

    const reqHeaders = stripHopByHop(new Headers(req.headers));
    reqHeaders.delete("host");
    reqHeaders.delete("authorization");

    reqHeaders.set("authorization", `Bearer ${mintServiceToken()}`);

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
        method: "GET",
        headers: reqHeaders,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
    } catch (err) {
      clearTimeout(timeoutId);
      const duration = Math.round(performance.now() - start);
      if (err instanceof DOMException && err.name === "TimeoutError") {
        log.error(
          { duration, upstream },
          "Brain graph proxy upstream timed out",
        );
        return Response.json({ error: "Gateway Timeout" }, { status: 504 });
      }
      log.error(
        { err, duration, upstream },
        "Brain graph proxy upstream connection failed",
      );
      return Response.json({ error: "Bad Gateway" }, { status: 502 });
    }

    const resHeaders = stripHopByHop(new Headers(response.headers));
    const duration = Math.round(performance.now() - start);

    if (response.status >= 400) {
      const body = await response.text();
      log.warn(
        { status: response.status, duration, upstream },
        "Brain graph proxy upstream error",
      );
      return new Response(body, {
        status: response.status,
        headers: resHeaders,
      });
    }

    log.info(
      { status: response.status, duration, upstream },
      "Brain graph proxy completed",
    );
    return new Response(response.body, {
      status: response.status,
      headers: resHeaders,
    });
  }

  async function handleBrainGraph(req: Request): Promise<Response> {
    return proxyTo(req, `${config.assistantRuntimeBaseUrl}/v1/brain-graph`);
  }

  async function handleBrainGraphUI(req: Request): Promise<Response> {
    return proxyTo(req, `${config.assistantRuntimeBaseUrl}/v1/brain-graph-ui`);
  }

  return { handleBrainGraph, handleBrainGraphUI };
}
