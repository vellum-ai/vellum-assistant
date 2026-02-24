/**
 * Gateway proxy endpoints for pairing requests.
 *
 * These routes are unauthenticated at the gateway level — they are
 * secured by the pairingSecret embedded in each request/query.
 * The gateway simply proxies to the daemon's pairing endpoints.
 */

import type { GatewayConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";

const log = getLogger("pairing-proxy");

/** 64 KB — pairing payloads are tiny JSON; cap well below maxWebhookPayloadBytes. */
const MAX_PAIRING_PAYLOAD_BYTES = 64 * 1024;

const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

function stripHopByHop(headers: Headers): Headers {
  const cleaned = new Headers(headers);
  const connectionValue = cleaned.get("connection");
  if (connectionValue) {
    for (const name of connectionValue.split(",")) {
      const trimmed = name.trim().toLowerCase();
      if (trimmed) {
        try {
          cleaned.delete(trimmed);
        } catch {
          // Ignore invalid header names
        }
      }
    }
  }
  for (const h of HOP_BY_HOP_HEADERS) {
    cleaned.delete(h);
  }
  return cleaned;
}

export function createPairingProxyHandler(config: GatewayConfig) {
  const TIMEOUT_MS = 15_000;

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

    // Add the runtime's bearer token for daemon auth on the register endpoint
    if (config.runtimeBearerToken) {
      reqHeaders.set("authorization", `Bearer ${config.runtimeBearerToken}`);
    }

    const hasBody = req.method !== "GET" && req.method !== "HEAD";

    // Payload size guard — reject oversized requests before buffering.
    if (hasBody) {
      const contentLength = req.headers.get("content-length");
      if (contentLength && Number(contentLength) > MAX_PAIRING_PAYLOAD_BYTES) {
        log.warn({ contentLength }, "Pairing proxy payload too large (content-length)");
        return Response.json({ error: "Payload too large" }, { status: 413 });
      }
    }

    const bodyBuffer = hasBody ? await req.arrayBuffer() : null;
    if (bodyBuffer !== null) {
      if (bodyBuffer.byteLength > MAX_PAIRING_PAYLOAD_BYTES) {
        log.warn({ bodyLength: bodyBuffer.byteLength }, "Pairing proxy payload too large");
        return Response.json({ error: "Payload too large" }, { status: 413 });
      }
      reqHeaders.set("content-length", String(bodyBuffer.byteLength));
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    }, TIMEOUT_MS);

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
        log.error({ path: upstreamPath, duration }, "Pairing proxy upstream timed out");
        return Response.json({ error: "Gateway Timeout" }, { status: 504 });
      }
      log.error({ err, path: upstreamPath, duration }, "Pairing proxy upstream connection failed");
      return Response.json({ error: "Bad Gateway" }, { status: 502 });
    }

    const resHeaders = stripHopByHop(new Headers(response.headers));
    const duration = Math.round(performance.now() - start);

    if (response.status >= 400) {
      const body = await response.text();
      log.warn({ path: upstreamPath, status: response.status, duration }, "Pairing proxy upstream error");
      return new Response(body, { status: response.status, headers: resHeaders });
    }

    log.info({ path: upstreamPath, status: response.status, duration }, "Pairing proxy completed");
    return new Response(response.body, { status: response.status, headers: resHeaders });
  }

  return {
    /** POST /pairing/request — proxy to daemon */
    async handlePairingRequest(req: Request): Promise<Response> {
      return proxyToRuntime(req, "/v1/pairing/request", "");
    },

    /** GET /pairing/status — proxy to daemon, forwarding query params */
    async handlePairingStatus(req: Request): Promise<Response> {
      const url = new URL(req.url);
      return proxyToRuntime(req, "/v1/pairing/status", url.search);
    },
  };
}
