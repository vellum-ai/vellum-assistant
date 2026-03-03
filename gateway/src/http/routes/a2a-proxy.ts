/**
 * Gateway proxy endpoints for A2A peer-to-peer handshake requests.
 *
 * These routes are the public-facing surface for inbound A2A connections from
 * other assistants. They proxy to the daemon runtime's internal A2A endpoints.
 *
 * Public (unauthenticated / invite-token-gated) routes:
 *   - POST /v1/a2a/connect — Peer initiates a connection with an invite token
 *   - POST /v1/a2a/verify — Peer submits a verification code
 *   - GET /v1/a2a/connections/:connectionId/status — Peer polls connection status
 *
 * The connect endpoint is unauthenticated because the peer doesn't have
 * credentials yet — they present an invite token instead. The verify and
 * status endpoints are also unauthenticated at the gateway level because
 * they occur during the handshake before credentials are exchanged.
 */

import { mintServiceToken } from "../../auth/token-exchange.js";
import type { GatewayConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";
import { stripHopByHop } from "../../util/strip-hop-by-hop.js";

const log = getLogger("a2a-proxy");

/** 64 KB — A2A handshake payloads are small JSON. */
const MAX_A2A_PAYLOAD_BYTES = 64 * 1024;

const TIMEOUT_MS = 15_000;

export function createA2AProxyHandler(config: GatewayConfig) {
  async function proxyToRuntime(
    req: Request,
    upstreamPath: string,
    upstreamSearch: string,
    clientIp?: string,
  ): Promise<Response> {
    const start = performance.now();
    const upstream = `${config.assistantRuntimeBaseUrl}${upstreamPath}${upstreamSearch}`;

    const reqHeaders = stripHopByHop(new Headers(req.headers));
    reqHeaders.delete("host");
    reqHeaders.delete("authorization");

    // Overwrite X-Forwarded-For with the actual client IP to prevent spoofing,
    // matching the pattern used by the runtime proxy.
    if (clientIp) {
      reqHeaders.set("x-forwarded-for", clientIp);
    }

    // Mint a short-lived service token for gateway->runtime auth
    reqHeaders.set("authorization", `Bearer ${mintServiceToken()}`);

    const hasBody = req.method !== "GET" && req.method !== "HEAD";

    // Payload size guard
    if (hasBody) {
      const contentLength = req.headers.get("content-length");
      if (contentLength) {
        const declared = Number(contentLength);
        if (declared > MAX_A2A_PAYLOAD_BYTES || Number.isNaN(declared)) {
          log.warn({ contentLength }, "A2A proxy payload too large (content-length)");
          return Response.json({ error: "Payload too large" }, { status: 413 });
        }
      }
    }

    const bodyBuffer = hasBody ? await req.arrayBuffer() : null;
    if (bodyBuffer !== null) {
      if (bodyBuffer.byteLength > MAX_A2A_PAYLOAD_BYTES) {
        log.warn({ bodyLength: bodyBuffer.byteLength }, "A2A proxy payload too large");
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
        log.error({ path: upstreamPath, duration }, "A2A proxy upstream timed out");
        return Response.json({ error: "Gateway Timeout" }, { status: 504 });
      }
      log.error({ err, path: upstreamPath, duration }, "A2A proxy upstream connection failed");
      return Response.json({ error: "Bad Gateway" }, { status: 502 });
    }

    const resHeaders = stripHopByHop(new Headers(response.headers));
    const duration = Math.round(performance.now() - start);

    if (response.status >= 400) {
      const body = await response.text();
      log.warn({ path: upstreamPath, status: response.status, duration }, "A2A proxy upstream error");
      return new Response(body, { status: response.status, headers: resHeaders });
    }

    log.info({ path: upstreamPath, status: response.status, duration }, "A2A proxy completed");
    return new Response(response.body, { status: response.status, headers: resHeaders });
  }

  return {
    /** POST /v1/a2a/connect — proxy to daemon (unauthenticated, invite-token-gated) */
    async handleConnect(req: Request, clientIp?: string): Promise<Response> {
      return proxyToRuntime(req, "/v1/a2a/connect", "", clientIp);
    },

    /** POST /v1/a2a/verify — proxy to daemon (unauthenticated during handshake) */
    async handleVerify(req: Request, clientIp?: string): Promise<Response> {
      return proxyToRuntime(req, "/v1/a2a/verify", "", clientIp);
    },

    /** GET /v1/a2a/connections/:connectionId/status — proxy to daemon */
    async handleConnectionStatus(req: Request, connectionId: string, clientIp?: string): Promise<Response> {
      return proxyToRuntime(req, `/v1/a2a/connections/${encodeURIComponent(connectionId)}/status`, "", clientIp);
    },
  };
}
