import type { Server } from "bun";

import { findVellumGuardian } from "../../auth/guardian-bootstrap.js";
import { resolveScopeProfile } from "../../auth/scopes.js";
import { parseSub } from "../../auth/subject.js";
import { validateEdgeToken } from "../../auth/token-exchange.js";
import type { Scope } from "../../auth/types.js";
import type { AuthRateLimiter } from "../../auth-rate-limiter.js";
import { credentialKey } from "../../credential-key.js";
import { readCredential } from "../../credential-reader.js";
import { getLogger } from "../../logger.js";
import { isLoopbackPeer } from "../../util/is-loopback-address.js";

const log = getLogger("auth");

type GetClientIp = () => string;

// ---------------------------------------------------------------------------
// DISABLE_HTTP_AUTH — platform-managed deployments bypass JWT validation
// ---------------------------------------------------------------------------

let _httpAuthDisabled: boolean | undefined;

/**
 * True when HTTP auth is disabled via DISABLE_HTTP_AUTH=true.
 * Cached after first call so the env var is only read once.
 */
export function isHttpAuthDisabled(): boolean {
  if (_httpAuthDisabled === undefined) {
    _httpAuthDisabled =
      process.env.DISABLE_HTTP_AUTH?.trim().toLowerCase() === "true";
  }
  return _httpAuthDisabled;
}

/**
 * Test-only: clear the cached `_httpAuthDisabled` so the next call re-reads
 * the env var. Production code should never call this.
 */
export function __resetHttpAuthDisabledCacheForTesting(): void {
  _httpAuthDisabled = undefined;
}

/**
 * Log the auth bypass state at gateway startup.
 * Call once from the main entrypoint after the logger is ready.
 */
export function logAuthBypassState(): void {
  if (!isHttpAuthDisabled()) return;
  const isPlatform =
    process.env.IS_PLATFORM?.trim().toLowerCase() === "true" ||
    process.env.IS_PLATFORM?.trim() === "1";
  if (isPlatform) {
    log.info(
      "DISABLE_HTTP_AUTH is set — HTTP auth disabled (expected: platform handles auth)",
    );
  } else {
    log.warn(
      "DISABLE_HTTP_AUTH is set — HTTP API authentication is DISABLED. All endpoints are accessible without a bearer token.",
    );
  }
}

/**
 * Build edge-auth guard functions that share a rate limiter and IP resolver.
 *
 * Both guards validate a JWT bearer token (aud=vellum-gateway) and record
 * failures against the rate limiter. `requireEdgeAuthWithScope` additionally
 * checks for a specific scope in the token's profile.
 *
 * When DISABLE_HTTP_AUTH is set (platform-managed deployments), all JWT
 * checks are bypassed — the platform handles authentication upstream.
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
    if (isHttpAuthDisabled()) return null;
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
    if (isHttpAuthDisabled()) return null;
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

  /**
   * Assert that the caller is the assistant's bound vellum guardian.
   *
   * Two auth modes — pick whichever applies to the deployment:
   *
   * 1. **DISABLE_HTTP_AUTH=true (platform-managed):** vembda has already
   *    authenticated the caller upstream. We require the platform to
   *    forward `X-Vellum-User-Id` and we cross-reference it with the
   *    stored `vellum:platform_user_id` credential. If they match, the
   *    caller is the guardian.
   *
   * 2. **Default (laptop / docker / bare-metal):** validate the edge JWT
   *    and require the caller's actor principal to match the bound
   *    vellum guardian's principal id (looked up via
   *    `findVellumGuardian()`).
   *
   * Loopback peers bypass entirely (consistent with sibling guards).
   */
  async function requireEdgeGuardianAuth(
    req: Request,
    server?: Server<unknown>,
  ): Promise<Response | null> {
    if (server && isLoopbackPeer(server, req)) return null;

    if (isHttpAuthDisabled()) {
      return requireEdgeGuardianAuthByPlatformHeader(req);
    }

    return requireEdgeGuardianAuthByActorPrincipal(req);
  }

  /**
   * Platform-managed path — caller's identity is asserted via
   * `X-Vellum-User-Id` (forwarded by vembda) cross-referenced against the
   * locally-stored `vellum:platform_user_id` credential.
   */
  async function requireEdgeGuardianAuthByPlatformHeader(
    req: Request,
  ): Promise<Response | null> {
    const headerUserId = req.headers.get("x-vellum-user-id");
    if (!headerUserId) {
      log.warn(
        { path: new URL(req.url).pathname },
        "Guardian edge auth rejected: missing X-Vellum-User-Id (DISABLE_HTTP_AUTH=true)",
      );
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    let storedUserId: string | undefined;
    try {
      storedUserId = await readCredential(
        credentialKey("vellum", "platform_user_id"),
      );
    } catch (err) {
      log.error(
        { path: new URL(req.url).pathname, err },
        "Guardian edge auth: platform_user_id credential lookup failed",
      );
      return Response.json({ error: "Service Unavailable" }, { status: 503 });
    }
    if (!storedUserId) {
      log.warn(
        { path: new URL(req.url).pathname },
        "Guardian edge auth rejected: no platform_user_id stored on this assistant",
      );
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    if (storedUserId !== headerUserId) {
      log.warn(
        { path: new URL(req.url).pathname },
        "Guardian edge auth rejected: X-Vellum-User-Id does not match stored platform_user_id",
      );
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    return null;
  }

  /**
   * Default path — validate JWT, require actor principal, assert it matches
   * the bound vellum guardian.
   */
  async function requireEdgeGuardianAuthByActorPrincipal(
    req: Request,
  ): Promise<Response | null> {
    const token = extractBearerToken(req);
    if (!token) {
      authRateLimiter.recordFailure(getClientIp());
      log.warn(
        { path: new URL(req.url).pathname },
        "Guardian edge auth rejected: missing or malformed Authorization header",
      );
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const result = validateEdgeToken(token);
    if (!result.ok) {
      authRateLimiter.recordFailure(getClientIp());
      log.warn(
        { path: new URL(req.url).pathname, reason: result.reason },
        "Guardian edge auth rejected: token validation failed",
      );
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const parsed = parseSub(result.claims.sub);
    if (
      !parsed.ok ||
      parsed.principalType !== "actor" ||
      !parsed.actorPrincipalId
    ) {
      log.warn(
        { path: new URL(req.url).pathname },
        "Guardian edge auth rejected: caller is not an actor principal",
      );
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    let guardian: { principalId: string } | null;
    try {
      guardian = await findVellumGuardian();
    } catch (err) {
      log.error(
        { path: new URL(req.url).pathname, err },
        "Guardian edge auth: findVellumGuardian failed",
      );
      return Response.json({ error: "Service Unavailable" }, { status: 503 });
    }
    if (!guardian || guardian.principalId !== parsed.actorPrincipalId) {
      log.warn(
        { path: new URL(req.url).pathname },
        "Guardian edge auth rejected: caller is not the bound guardian",
      );
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    return null;
  }

  return {
    requireEdgeAuth,
    requireEdgeAuthWithScope,
    requireEdgeGuardianAuth,
  };
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
