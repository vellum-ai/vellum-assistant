import {
  buildUpstreamUrl,
  prepareUpstreamHeaders,
  createTimeoutController,
  isTimeoutError,
  stripHopByHop,
} from "@vellumai/assistant-client";

import {
  validateEdgeToken,
  mintExchangeToken,
  mintServiceToken,
} from "../../auth/token-exchange.js";
import type { GatewayConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";
import { isLoopbackAddress } from "../../util/is-loopback-address.js";
import { tryIpcProxy } from "./ipc-runtime-proxy.js";

const log = getLogger("runtime-proxy");

/**
 * Webhook paths are handled exclusively by the gateway's own route handlers
 * and must never be forwarded to the runtime. This prevents external webhook
 * traffic from bypassing gateway-level validation (signature checks, rate
 * limiting, etc.).
 */
const WEBHOOK_PATH_RE = /^\/webhooks\//;

export function createRuntimeProxyHandler(config: GatewayConfig) {
  return async (req: Request, clientIp?: string): Promise<Response> => {
    const start = performance.now();
    const url = new URL(req.url);

    // Block forwarding of /webhooks/* paths — these are gateway-only.
    if (WEBHOOK_PATH_RE.test(url.pathname)) {
      log.warn(
        { method: req.method, path: url.pathname },
        "Blocked runtime proxy forwarding of webhook path",
      );
      return Response.json(
        { error: "Not found", source: "gateway" },
        { status: 404 },
      );
    }

    // IPC fast-path: when the client sends X-Vellum-Proxy-Server: ipc and
    // the route is in the schema cache, serve via IPC instead of HTTP.
    // Auth is handled inside tryIpcProxy — it replicates the same JWT
    // validation as the HTTP path below.
    const ipcResponse = await tryIpcProxy(req, config);
    if (ipcResponse) return ipcResponse;

    // Validate the edge JWT (aud=vellum-gateway) when auth is required.
    // On success, mint an exchange token (aud=vellum-daemon) for the runtime.
    // When auth is not required (or OPTIONS), mint a service token instead —
    // the gateway always authenticates itself to the daemon regardless of the
    // client-facing auth setting.
    let exchangeToken: string;
    const isLoopback = clientIp ? isLoopbackAddress(clientIp) : false;
    const authHeader = req.headers.get("authorization");
    const hasBearer = authHeader?.toLowerCase().startsWith("bearer ") ?? false;

    if (config.runtimeProxyRequireAuth && req.method !== "OPTIONS" && (!isLoopback || hasBearer)) {
      if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
        log.warn(
          { method: req.method, path: url.pathname },
          "Runtime proxy auth rejected: missing or malformed Authorization header",
        );
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const edgeJwt = authHeader.slice(7);
      const result = validateEdgeToken(edgeJwt);
      if (!result.ok) {
        log.warn(
          { method: req.method, path: url.pathname, reason: result.reason },
          "Runtime proxy auth rejected: edge token validation failed",
        );
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      exchangeToken = mintExchangeToken(
        result.claims,
        result.claims.scope_profile,
      );
    } else {
      exchangeToken = mintServiceToken();
    }

    // The daemon uses flat /v1/... paths. Rewrite any legacy
    // /v1/assistants/:assistantId/... requests from clients to flat paths.
    let upstreamPath = url.pathname;
    const assistantScopedMatch = url.pathname.match(
      /^\/v1\/assistants\/[^/]+\/(.+)$/,
    );
    if (assistantScopedMatch) {
      upstreamPath = `/v1/${assistantScopedMatch[1]}`;
    }

    const upstream = buildUpstreamUrl(
      config.assistantRuntimeBaseUrl,
      upstreamPath,
      url.search,
    );

    const reqHeaders = prepareUpstreamHeaders(
      new Headers(req.headers),
      exchangeToken,
    );

    // Inject the real client IP so the runtime can rate-limit per-user,
    // overwriting any client-supplied value to prevent spoofing.
    // Strip the header for loopback peers: the runtime rejects any request
    // with x-forwarded-for in bare-metal mode, and forwarding 127.0.0.1
    // conveys no useful information.
    if (clientIp && !isLoopbackAddress(clientIp)) {
      reqHeaders.set("x-forwarded-for", clientIp);
    } else {
      reqHeaders.delete("x-forwarded-for");
    }

    // Use a manual AbortController so the timeout only covers the connection
    // phase (waiting for response headers). Once headers arrive, the timeout is
    // cleared so streaming responses (SSE, chunked) can run indefinitely.
    const { controller, clear } = createTimeoutController(
      config.runtimeTimeoutMs,
    );

    // Buffer the request body instead of streaming req.body to avoid
    // Content-Length mismatches when Bun re-sends a ReadableStream, which
    // can cause the upstream to reject the request with a bare 400.
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const bodyBuffer = hasBody ? await req.arrayBuffer() : null;
    if (bodyBuffer !== null) {
      reqHeaders.set("content-length", String(bodyBuffer.byteLength));
    }

    let response: Response;
    try {
      response = await fetchImpl(upstream, {
        method: req.method,
        headers: reqHeaders,
        body: bodyBuffer,
        signal: controller.signal,
      });
      clear();
    } catch (err) {
      clear();
      const duration = Math.round(performance.now() - start);
      if (isTimeoutError(err)) {
        log.error(
          {
            method: req.method,
            path: url.pathname,
            duration,
            timeoutMs: config.runtimeTimeoutMs,
          },
          "Upstream request timed out",
        );
        return Response.json({ error: "Gateway Timeout" }, { status: 504 });
      }
      log.error(
        { err, method: req.method, path: url.pathname, duration },
        "Upstream connection failed",
      );
      return Response.json({ error: "Bad Gateway" }, { status: 502 });
    }

    const resHeaders = stripHopByHop(new Headers(response.headers));
    const duration = Math.round(performance.now() - start);

    if (response.status >= 400) {
      const body = await response.text();
      const level = response.status >= 500 ? "error" : "warn";
      const bodySnippet =
        body.length > 256 ? body.slice(0, 256) + "\u2026[truncated]" : body;
      log[level](
        {
          method: req.method,
          path: url.pathname,
          status: response.status,
          duration,
          body: bodySnippet,
        },
        "Upstream returned error",
      );
      return new Response(body, {
        status: response.status,
        headers: resHeaders,
      });
    }

    log.info(
      {
        method: req.method,
        path: url.pathname,
        status: response.status,
        duration,
      },
      "Proxy request completed",
    );

    return new Response(response.body, {
      status: response.status,
      headers: resHeaders,
    });
  };
}
