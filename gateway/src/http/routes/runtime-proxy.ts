import type { GatewayConfig } from "../../config.js";
import { getLogger } from "../../logger.js";
import { validateBearerToken } from "../auth/bearer.js";
import { GATEWAY_ORIGIN_HEADER } from "../../runtime/client.js";

const log = getLogger("runtime-proxy");

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

  // Also strip any headers listed in the Connection header value
  const connectionValue = cleaned.get("connection");
  if (connectionValue) {
    for (const name of connectionValue.split(",")) {
      const trimmed = name.trim().toLowerCase();
      if (trimmed) {
        try {
          cleaned.delete(trimmed);
        } catch {
          // Ignore invalid header names (e.g., malformed Connection tokens like "@@@")
        }
      }
    }
  }

  for (const h of HOP_BY_HOP_HEADERS) {
    cleaned.delete(h);
  }
  return cleaned;
}

/**
 * Webhook paths are handled exclusively by the gateway's own route handlers
 * and must never be forwarded to the runtime. This prevents external webhook
 * traffic from bypassing gateway-level validation (signature checks, rate
 * limiting, etc.).
 */
const WEBHOOK_PATH_RE = /^\/webhooks\//;

export function createRuntimeProxyHandler(config: GatewayConfig) {
  return async (req: Request): Promise<Response> => {
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

    if (config.runtimeProxyRequireAuth && req.method !== "OPTIONS") {
      if (!config.runtimeProxyBearerToken) {
        return Response.json({ error: "Server misconfigured" }, { status: 500 });
      }
      const authResult = validateBearerToken(
        req.headers.get("authorization"),
        config.runtimeProxyBearerToken,
      );
      if (!authResult.authorized) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    // Rewrite /v1/assistants/:assistantId/... → /v1/... for the upstream daemon
    let upstreamPath = url.pathname;
    const assistantScopedMatch = url.pathname.match(/^\/v1\/assistants\/[^/]+\/(.+)$/);
    if (assistantScopedMatch) {
      upstreamPath = `/v1/${assistantScopedMatch[1]}`;
    }

    const upstream = `${config.assistantRuntimeBaseUrl}${upstreamPath}${url.search}`;

    const reqHeaders = stripHopByHop(new Headers(req.headers));
    reqHeaders.delete("host");
    // Only strip the authorization header when the gateway consumed it for its
    // own auth check. When auth is not required, the header may be intended for
    // the upstream service and must be forwarded.
    if (config.runtimeProxyRequireAuth) {
      reqHeaders.delete("authorization");
    }

    // Add the runtime's bearer token so the upstream accepts the request
    if (config.runtimeBearerToken) {
      reqHeaders.set("authorization", `Bearer ${config.runtimeBearerToken}`);
    }
    // Attach gateway-origin proof using the dedicated secret (falls back
    // to runtimeBearerToken via config when not explicitly configured).
    if (config.runtimeGatewayOriginSecret) {
      reqHeaders.set(GATEWAY_ORIGIN_HEADER, config.runtimeGatewayOriginSecret);
    }

    if (config.runtimeProxyBearerToken) {
      reqHeaders.set("authorization", `Bearer ${config.runtimeProxyBearerToken}`);
    }

    // Use a manual AbortController so the timeout only covers the connection
    // phase (waiting for response headers). Once headers arrive, the timeout is
    // cleared so streaming responses (SSE, chunked) can run indefinitely.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    }, config.runtimeTimeoutMs);

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
      response = await fetch(upstream, {
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
          { method: req.method, path: url.pathname, duration, timeoutMs: config.runtimeTimeoutMs },
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
      const bodySnippet = body.length > 256 ? body.slice(0, 256) + "…[truncated]" : body;
      log[level](
        { method: req.method, path: url.pathname, status: response.status, duration, body: bodySnippet },
        "Upstream returned error",
      );
      return new Response(body, {
        status: response.status,
        headers: resHeaders,
      });
    }

    log.info(
      { method: req.method, path: url.pathname, status: response.status, duration },
      "Proxy request completed",
    );

    return new Response(response.body, {
      status: response.status,
      headers: resHeaders,
    });
  };
}
