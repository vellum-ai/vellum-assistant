/**
 * IPC runtime proxy — serves HTTP requests by calling the assistant daemon
 * over IPC instead of forwarding them as HTTP.
 *
 * Activated when the client sends the `X-Vellum-Proxy-Server: ipc` header
 * AND the request path matches a route in the schema cache. This is the
 * testing gate for the IPC cutover; once proven, the header check is removed
 * and IPC becomes the default transport.
 *
 * The proxy translates the HTTP request into the structured RouteHandlerArgs
 * shape that transport-agnostic route handlers expect, calls the daemon via
 * IPC, and converts the result back into an HTTP Response.
 */

import {
  getIpcRoutePolicy,
  type IpcRoutePolicy,
} from "../../auth/ipc-route-policy.js";
import { resolveScopeProfile } from "../../auth/scopes.js";
import { parseSub } from "../../auth/subject.js";
import { validateEdgeToken } from "../../auth/token-exchange.js";
import type { TokenClaims } from "../../auth/types.js";
import type { GatewayConfig } from "../../config.js";
import {
  IpcHandlerError,
  IpcTransportError,
  ipcCallAssistant,
} from "../../ipc/assistant-client.js";
import { matchRoute } from "../../ipc/route-schema-cache.js";
import { getLogger } from "../../logger.js";

const log = getLogger("ipc-runtime-proxy");

const V1_PREFIX = "/v1/";
const VELLUM_HEADER_PREFIX = "x-vellum-";

/**
 * Attempt to serve a request via IPC.
 *
 * Returns `null` when the request doesn't have the
 * `X-Vellum-Proxy-Server: ipc` header — the caller should fall through
 * to the HTTP proxy.
 *
 * Once the header is present, the proxy commits to serving the request
 * over IPC: path mismatches return 404 and errors return proper status
 * codes rather than falling through.
 */
export async function tryIpcProxy(
  req: Request,
  config: GatewayConfig,
): Promise<Response | null> {
  if (req.headers.get("x-vellum-proxy-server") !== "ipc") {
    return null;
  }

  // --- Auth: replicate the gateway's JWT validation -----------------------
  let claims: TokenClaims | undefined;

  if (config.runtimeProxyRequireAuth && req.method !== "OPTIONS") {
    const authHeader = req.headers.get("authorization");
    if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const edgeJwt = authHeader.slice(7);
    const result = validateEdgeToken(edgeJwt);
    if (!result.ok) {
      log.warn(
        {
          method: req.method,
          path: new URL(req.url).pathname,
          reason: result.reason,
        },
        "IPC proxy auth rejected",
      );
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    claims = result.claims;
  }

  // --- Route matching -----------------------------------------------------
  const url = new URL(req.url);
  const pathname = url.pathname;

  if (!pathname.startsWith(V1_PREFIX)) {
    return Response.json(
      { error: "Not found", source: "ipc-proxy" },
      { status: 404 },
    );
  }

  const routePath = pathname.slice(V1_PREFIX.length);
  const match = matchRoute(req.method, routePath);
  if (!match) {
    return Response.json(
      { error: "Not found", source: "ipc-proxy" },
      { status: 404 },
    );
  }

  // --- Policy enforcement --------------------------------------------------
  const policy = getIpcRoutePolicy(match.operationId);
  const policyDenied = enforceRoutePolicy(policy, claims, pathname);
  if (policyDenied) return policyDenied;

  const start = performance.now();

  // --- Build structured IPC params ----------------------------------------
  const queryParams: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) {
    queryParams[key] = value;
  }

  // Only forward X-Vellum-* headers to the daemon.
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    if (key.startsWith(VELLUM_HEADER_PREFIX)) {
      headers[key] = value;
    }
  });

  // Override caller-supplied identity headers with values derived from the
  // verified JWT claims. The daemon's IPC adapter (`injectLocalActorHeader`)
  // preserves any inbound `x-vellum-actor-principal-id`, so without this
  // step a malicious client could spoof another user's principal id by
  // setting the header explicitly. Mirrors the HTTP adapter's behavior in
  // `assistant/src/runtime/routes/http-adapter.ts`.
  delete headers["x-vellum-actor-principal-id"];
  delete headers["x-vellum-principal-type"];
  if (claims) {
    const sub = parseSub(claims.sub);
    if (sub.ok) {
      headers["x-vellum-principal-type"] = sub.principalType;
      if (sub.actorPrincipalId) {
        headers["x-vellum-actor-principal-id"] = sub.actorPrincipalId;
      }
    }
  }

  let body: Record<string, unknown> | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("application/json") || contentType === "") {
      try {
        const parsed = (await req.json()) as Record<string, unknown>;
        if (parsed && typeof parsed === "object") {
          body = parsed;
        }
      } catch {
        // No body or invalid JSON — handler will validate
      }
    }
  }

  const params: Record<string, unknown> = {
    pathParams: match.pathParams,
    queryParams,
    body,
    headers,
  };

  // --- Call daemon via IPC ------------------------------------------------
  try {
    const result = await ipcCallAssistant(match.operationId, params);

    const duration = Math.round(performance.now() - start);
    log.info(
      {
        method: req.method,
        path: pathname,
        operationId: match.operationId,
        duration,
      },
      "IPC proxy request completed",
    );

    if (result === undefined || result === null) {
      return new Response(null, { status: 204 });
    }

    if (typeof result === "string") {
      return new Response(result);
    }

    return Response.json(result);
  } catch (err) {
    const duration = Math.round(performance.now() - start);

    if (err instanceof IpcHandlerError) {
      log.warn(
        {
          method: req.method,
          path: pathname,
          operationId: match.operationId,
          statusCode: err.statusCode,
          errorCode: err.code,
          duration,
        },
        "IPC proxy handler error",
      );
      return Response.json(
        { error: err.message, code: err.code },
        { status: err.statusCode },
      );
    }

    if (err instanceof IpcTransportError) {
      log.error(
        {
          err,
          method: req.method,
          path: pathname,
          operationId: match.operationId,
          duration,
        },
        "IPC proxy transport error",
      );
      return Response.json({ error: "Bad Gateway" }, { status: 502 });
    }

    log.error(
      {
        err,
        method: req.method,
        path: pathname,
        operationId: match.operationId,
        duration,
      },
      "IPC proxy unexpected error",
    );
    return Response.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Policy enforcement
// ---------------------------------------------------------------------------

/**
 * Enforce the route's scope/principal policy against the caller's token.
 * Returns a 403 Response when denied, null when allowed.
 */
function enforceRoutePolicy(
  policy: IpcRoutePolicy | undefined,
  claims: TokenClaims | undefined,
  path: string,
): Response | null {
  if (!policy) return null;

  // When auth is disabled (dev mode), no claims → skip enforcement.
  if (!claims) return null;

  // Check principal type.
  if (policy.allowedPrincipalTypes.length > 0) {
    const subResult = parseSub(claims.sub);
    if (!subResult.ok) {
      log.warn(
        { path, sub: claims.sub, reason: subResult.reason },
        "IPC proxy policy denied: failed to parse sub claim",
      );
      return Response.json(
        {
          error: {
            code: "FORBIDDEN",
            message: "Unable to determine principal type",
          },
        },
        { status: 403 },
      );
    }
    if (!policy.allowedPrincipalTypes.includes(subResult.principalType)) {
      log.warn(
        {
          path,
          principalType: subResult.principalType,
          allowed: policy.allowedPrincipalTypes,
        },
        "IPC proxy policy denied: principal type not allowed",
      );
      return Response.json(
        {
          error: {
            code: "FORBIDDEN",
            message: "Principal type not permitted for this endpoint",
          },
        },
        { status: 403 },
      );
    }
  }

  // Check required scopes.
  const scopes = resolveScopeProfile(claims.scope_profile);
  for (const required of policy.requiredScopes) {
    if (!scopes.has(required)) {
      log.warn(
        { path, missingScope: required },
        "IPC proxy policy denied: missing required scope",
      );
      return Response.json(
        {
          error: {
            code: "FORBIDDEN",
            message: `Missing required scope: ${required}`,
          },
        },
        { status: 403 },
      );
    }
  }

  return null;
}
