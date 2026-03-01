/**
 * Gateway proxy endpoint for LLM generation requests.
 *
 * Exposes POST /v1/llm/generate through the gateway even when the broad
 * runtime proxy is disabled. This lets host-target skill tools call the
 * daemon's provider abstraction layer via $INTERNAL_GATEWAY_BASE_URL without
 * requiring GATEWAY_RUNTIME_PROXY_ENABLED=true.
 */

import type { GatewayConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";
import { GATEWAY_ORIGIN_HEADER } from "../../runtime/client.js";
import { stripHopByHop } from "../../util/strip-hop-by-hop.js";

const log = getLogger("llm-generate-proxy");

export function createLlmGenerateProxyHandler(config: GatewayConfig) {
  async function handleLlmGenerate(req: Request): Promise<Response> {
    const start = performance.now();
    const upstream = `${config.assistantRuntimeBaseUrl}/v1/llm/generate`;

    const reqHeaders = stripHopByHop(new Headers(req.headers));
    reqHeaders.delete("host");
    reqHeaders.delete("authorization");

    if (config.runtimeBearerToken) {
      reqHeaders.set("authorization", `Bearer ${config.runtimeBearerToken}`);
    }
    if (config.runtimeGatewayOriginSecret) {
      reqHeaders.set(GATEWAY_ORIGIN_HEADER, config.runtimeGatewayOriginSecret);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    }, config.runtimeTimeoutMs);

    const bodyBuffer = await req.arrayBuffer();
    reqHeaders.set("content-length", String(bodyBuffer.byteLength));

    let response: Response;
    try {
      response = await fetchImpl(upstream, {
        method: "POST",
        headers: reqHeaders,
        body: bodyBuffer,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
    } catch (err) {
      clearTimeout(timeoutId);
      const duration = Math.round(performance.now() - start);
      if (err instanceof DOMException && err.name === "TimeoutError") {
        log.error({ duration }, "LLM generate proxy upstream timed out");
        return Response.json({ error: "Gateway Timeout" }, { status: 504 });
      }
      log.error({ err, duration }, "LLM generate proxy upstream connection failed");
      return Response.json({ error: "Bad Gateway" }, { status: 502 });
    }

    const resHeaders = stripHopByHop(new Headers(response.headers));
    const duration = Math.round(performance.now() - start);

    if (response.status >= 400) {
      const body = await response.text();
      const level = response.status >= 500 ? "error" : "warn";
      log[level]({ status: response.status, duration }, "LLM generate proxy upstream error");
      return new Response(body, { status: response.status, headers: resHeaders });
    }

    log.info({ status: response.status, duration }, "LLM generate proxy completed");
    return new Response(response.body, { status: response.status, headers: resHeaders });
  }

  return { handleLlmGenerate };
}
