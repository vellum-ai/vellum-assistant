/**
 * Gateway proxy endpoints for pairing requests.
 *
 * These routes are unauthenticated at the gateway level — they are
 * secured by the pairingSecret embedded in each request/query.
 * The gateway simply proxies to the daemon's pairing endpoints.
 */

import { proxyForwardToResponse } from "@vellumai/assistant-client";

import { mintServiceToken } from "../../auth/token-exchange.js";
import type { GatewayConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";

const log = getLogger("pairing-proxy");

/** 64 KB — pairing payloads are tiny JSON; cap well below maxWebhookPayloadBytes. */
const MAX_PAIRING_PAYLOAD_BYTES = 64 * 1024;

export function createPairingProxyHandler(config: GatewayConfig) {
  const TIMEOUT_MS = 15_000;

  async function proxyToRuntime(
    req: Request,
    upstreamPath: string,
    upstreamSearch: string,
  ): Promise<Response> {
    // Payload size guard — primary defense: reject via Content-Length before
    // reading the body into memory. This is the main protection against
    // oversized requests because Bun's Request.arrayBuffer() buffers the
    // entire body with no streaming-limit API, so once we call it the
    // memory is already allocated.
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    if (hasBody) {
      const contentLength = req.headers.get("content-length");
      if (contentLength) {
        const declared = Number(contentLength);
        if (declared > MAX_PAIRING_PAYLOAD_BYTES || Number.isNaN(declared)) {
          log.warn(
            { contentLength },
            "Pairing proxy payload too large (content-length)",
          );
          return Response.json({ error: "Payload too large" }, { status: 413 });
        }
      }
    }

    // Belt-and-suspenders: peek at the actual body size before forwarding.
    // We need to buffer it here anyway for the size check, then wrap it in
    // a new Request so proxyForwardToResponse can re-buffer it without a
    // double-consume error.
    if (hasBody) {
      const bodyBuffer = await req.arrayBuffer();
      if (bodyBuffer.byteLength > MAX_PAIRING_PAYLOAD_BYTES) {
        log.warn(
          { bodyLength: bodyBuffer.byteLength },
          "Pairing proxy payload too large",
        );
        return Response.json({ error: "Payload too large" }, { status: 413 });
      }

      // Rebuild the request with the buffered body so the shared helper
      // can consume it without hitting a "body already used" error.
      req = new Request(req.url, {
        method: req.method,
        headers: req.headers,
        body: bodyBuffer,
      });
    }

    const start = performance.now();
    const response = await proxyForwardToResponse(req, {
      baseUrl: config.assistantRuntimeBaseUrl,
      path: upstreamPath,
      search: upstreamSearch || undefined,
      serviceToken: mintServiceToken(),
      timeoutMs: TIMEOUT_MS,
      fetchImpl,
    });
    const duration = Math.round(performance.now() - start);

    if (response.status >= 500) {
      log.error(
        { path: upstreamPath, status: response.status, duration },
        "Pairing proxy upstream error",
      );
    } else if (response.status >= 400) {
      log.warn(
        { path: upstreamPath, status: response.status, duration },
        "Pairing proxy upstream error",
      );
    } else {
      log.info(
        { path: upstreamPath, status: response.status, duration },
        "Pairing proxy completed",
      );
    }

    return response;
  }

  return {
    /** POST /pairing/register — proxy to daemon (bearer-authenticated) */
    async handlePairingRegister(req: Request): Promise<Response> {
      return proxyToRuntime(req, "/v1/pairing/register", "");
    },

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
