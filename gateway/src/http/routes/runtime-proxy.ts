import type { GatewayConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";
import { stripHopByHop } from "../../util/strip-hop-by-hop.js";
import { validateBearerToken } from "../auth/bearer.js";
import { GATEWAY_ORIGIN_HEADER } from "../../runtime/client.js";

const log = getLogger("runtime-proxy");

/**
 * Webhook paths are handled exclusively by the gateway's own route handlers
 * and must never be forwarded to the runtime. This prevents external webhook
 * traffic from bypassing gateway-level validation (signature checks, rate
 * limiting, etc.).
 */
const WEBHOOK_PATH_RE = /^\/webhooks\//;

/**
 * Actor-bound runtime routes for vellum user interactions.
 * These routes require actor identity at runtime and can be authenticated at
 * the gateway using `Authorization: Actor <token>` (client ergonomics), which
 * the gateway maps to upstream `X-Actor-Token`.
 */
const ACTOR_BOUND_ROUTE_MATCHERS: Array<{ method: string; path: RegExp }> = [
  { method: "POST", path: /^\/v1\/messages$/ },
  { method: "GET", path: /^\/v1\/events$/ },
  { method: "POST", path: /^\/v1\/confirm$/ },
  { method: "POST", path: /^\/v1\/secret$/ },
  { method: "POST", path: /^\/v1\/trust-rules$/ },
  { method: "GET", path: /^\/v1\/pending-interactions$/ },
  { method: "GET", path: /^\/v1\/guardian-actions\/pending$/ },
  { method: "POST", path: /^\/v1\/guardian-actions\/decision$/ },
];

function isActorBoundRoute(method: string, upstreamPath: string): boolean {
  return ACTOR_BOUND_ROUTE_MATCHERS.some((matcher) =>
    matcher.method === method && matcher.path.test(upstreamPath),
  );
}

function extractActorAuthorizationToken(authorizationHeader: string | null): string | null {
  if (!authorizationHeader) return null;
  if (!authorizationHeader.slice(0, 6).toLowerCase().startsWith("actor ")) {
    return null;
  }
  const token = authorizationHeader.slice(6).trim();
  return token.length > 0 ? token : null;
}

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

    // The daemon uses flat /v1/... paths. Rewrite any legacy
    // /v1/assistants/:assistantId/... requests from clients to flat paths.
    let upstreamPath = url.pathname;
    const assistantScopedMatch = url.pathname.match(/^\/v1\/assistants\/[^/]+\/(.+)$/);
    if (assistantScopedMatch) {
      upstreamPath = `/v1/${assistantScopedMatch[1]}`;
    }
    const isActorRoute = isActorBoundRoute(req.method, upstreamPath);
    const actorTokenFromAuthorization = extractActorAuthorizationToken(
      req.headers.get("authorization"),
    );
    const hasActorAuthorization = isActorRoute && actorTokenFromAuthorization !== null;

    if (config.runtimeProxyRequireAuth && req.method !== "OPTIONS" && !hasActorAuthorization) {
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

    const upstream = `${config.assistantRuntimeBaseUrl}${upstreamPath}${url.search}`;

    const reqHeaders = stripHopByHop(new Headers(req.headers));
    reqHeaders.delete("host");
    // Only strip the authorization header when the gateway consumed it for its
    // own auth check. When auth is not required, the header may be intended for
    // the upstream service and must be forwarded.
    if (config.runtimeProxyRequireAuth || hasActorAuthorization) {
      reqHeaders.delete("authorization");
    }
    if (actorTokenFromAuthorization) {
      reqHeaders.set("x-actor-token", actorTokenFromAuthorization);
    }

    // Inject the real client IP so the runtime can rate-limit per-user,
    // overwriting any client-supplied value to prevent spoofing.
    if (clientIp) {
      reqHeaders.set('x-forwarded-for', clientIp);
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
