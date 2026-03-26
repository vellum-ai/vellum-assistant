import type { Server } from "bun";

import { validateEdgeToken } from "../../auth/token-exchange.js";
import { resolveScopeProfile } from "../../auth/scopes.js";
import type { Scope } from "../../auth/types.js";
import type { AuthRateLimiter } from "../../auth-rate-limiter.js";
import { getLogger } from "../../logger.js";
import { isLoopbackPeer } from "../routes/browser-relay-websocket.js";

const log = getLogger("auth");

type GetClientIp = () => string;

/**
 * Build edge-auth guard functions that share a rate limiter and IP resolver.
 *
 * Both guards validate a JWT bearer token (aud=vellum-gateway) and record
 * failures against the rate limiter. `requireEdgeAuthWithScope` additionally
 * checks for a specific scope in the token's profile.
 */
export function createAuthMiddleware(
  authRateLimiter: AuthRateLimiter,
  getClientIp: GetClientIp,
) {
  /**
   * Validate a JWT bearer token (aud=vellum-gateway) for client-facing routes.
   * Loopback peers (127.0.0.0/8, ::1) are auto-authenticated without a token.
   * Returns null on success, or a Response to short-circuit with.
   */
  function requireEdgeAuth(
    req: Request,
    server?: Server<unknown>,
  ): Response | null {
    if (server && isLoopbackPeer(server, req)) {
      return null;
    }
    const token = extractBearerToken(req);
    if (!token) {
      authRateLimiter.recordFailure(getClientIp());
      log.warn(
        { path: new URL(req.url).pathname },
        "Edge auth rejected: missing or malformed Authorization header",
      );
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const result = validateEdgeToken(token);
    if (!result.ok) {
      authRateLimiter.recordFailure(getClientIp());
      log.warn(
        { path: new URL(req.url).pathname, reason: result.reason },
        "Edge auth rejected: token validation failed",
      );
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    return null;
  }

  /**
   * Validate a JWT bearer token and check that its scope profile
   * includes a specific scope. Loopback peers bypass JWT validation
   * and are granted all scopes. Returns null on success.
   */
  function requireEdgeAuthWithScope(
    req: Request,
    scope: Scope,
    server?: Server<unknown>,
  ): Response | null {
    if (server && isLoopbackPeer(server, req)) {
      return null;
    }
    const token = extractBearerToken(req);
    if (!token) {
      authRateLimiter.recordFailure(getClientIp());
      log.warn(
        { path: new URL(req.url).pathname, scope },
        "Scoped edge auth rejected: missing or malformed Authorization header",
      );
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const result = validateEdgeToken(token);
    if (!result.ok) {
      authRateLimiter.recordFailure(getClientIp());
      log.warn(
        { path: new URL(req.url).pathname, scope, reason: result.reason },
        "Scoped edge auth rejected: token validation failed",
      );
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const scopes = resolveScopeProfile(result.claims.scope_profile);
    if (!scopes.has(scope)) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    return null;
  }

  return { requireEdgeAuth, requireEdgeAuthWithScope };
}

/**
 * Wrap a handler so that responses with specific status codes automatically
 * record an auth failure. Defaults to tracking 401 responses.
 *
 * Eliminates the repeated `if (res.status === 401) { ... }` boilerplate.
 */
export function wrapWithAuthFailureTracking(
  handler: (req: Request) => Promise<Response> | Response,
  authRateLimiter: AuthRateLimiter,
  getClientIp: GetClientIp,
  failureStatuses: readonly number[] = [401],
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const res = await handler(req);
    if (failureStatuses.includes(res.status)) {
      authRateLimiter.recordFailure(getClientIp());
    }
    return res;
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Extract the raw token from a Bearer Authorization header, or null. */
function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.get("authorization");
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
    return null;
  }
  return authHeader.slice(7);
}
