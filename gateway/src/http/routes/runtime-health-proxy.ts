/**
 * Gateway proxy endpoint for runtime health checks.
 *
 * Exposes GET /v1/health through the gateway even when the broad runtime
 * proxy is disabled.
 */

import { mintServiceToken } from "../../auth/token-exchange.js";
import type { GatewayConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";
import { isAssistantOOMKilled } from "../../runtime/docker-health.js";
import { stripHopByHop } from "../../util/strip-hop-by-hop.js";

const log = getLogger("runtime-health-proxy");

export function createRuntimeHealthProxyHandler(config: GatewayConfig) {
  async function handleRuntimeHealth(req: Request): Promise<Response> {
    const start = performance.now();
    const upstream = `${config.assistantRuntimeBaseUrl}/v1/health`;

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
        log.error({ duration }, "Runtime health proxy upstream timed out");
        return Response.json({ error: "Gateway Timeout" }, { status: 504 });
      }
      log.error(
        { err, duration },
        "Runtime health proxy upstream connection failed",
      );

      const oom = await isAssistantOOMKilled();
      if (oom) {
        log.error("Assistant container was OOM-killed");
        return Response.json(
          {
            error:
              "Assistant process was killed (OOM). Restart with more memory.",
          },
          { status: 503 },
        );
      }
      return Response.json({ error: "Bad Gateway" }, { status: 502 });
    }

    const resHeaders = stripHopByHop(new Headers(response.headers));
    const duration = Math.round(performance.now() - start);

    if (response.status >= 400) {
      const body = await response.text();
      log.warn(
        { status: response.status, duration },
        "Runtime health proxy upstream error",
      );
      return new Response(body, {
        status: response.status,
        headers: resHeaders,
      });
    }

    log.info(
      { status: response.status, duration },
      "Runtime health proxy completed",
    );
    return new Response(response.body, {
      status: response.status,
      headers: resHeaders,
    });
  }

  return { handleRuntimeHealth };
}
