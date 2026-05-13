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
// Platform-managed auth bypass — DISABLE_HTTP_AUTH + IS_PLATFORM
// ---------------------------------------------------------------------------
//
// Both flags must be set together to disable JWT validation. DISABLE_HTTP_AUTH
// alone is insufficient — it closes the accidental misconfig case where the
// flag gets set on a non-platform deployment (e.g. a leaked dev env var on a
// public host). When the bypass IS active, the platform vembda sidecar is
// expected to forward `X-Vellum-User-Id`; the gateway cross-checks that
// against the locally-stored `vellum:platform_user_id` credential. This means
// reaching the gateway sidecar's port directly (without going through vembda)
// still requires knowing the bound user id — the platform header alone is
// not a free-pass.

/** True when DISABLE_HTTP_AUTH=true. */
export function isHttpAuthDisabled(): boolean {
  return process.env.DISABLE_HTTP_AUTH?.trim().toLowerCase() === "true";
}

/** True when IS_PLATFORM is set (vembda-managed deployment). */
function isPlatformManaged(): boolean {
  const v = process.env.IS_PLATFORM?.trim();
  return v === "1" || v?.toLowerCase() === "true";
}

/**
 * True when the platform-managed auth bypass is in effect — both flags set.
 * Either alone leaves JWT validation in place.
 */
function isPlatformAuthBypassActive(): boolean {
  return isHttpAuthDisabled() && isPlatformManaged();
}

/**
 * Log auth bypass state at gateway startup. Call once after the logger is
 * initialized.
 */
export function logAuthBypassState(): void {
  if (!isHttpAuthDisabled()) return;
  if (isPlatformManaged()) {
    log.info(
      "DISABLE_HTTP_AUTH + IS_PLATFORM both set — JWT validation bypassed; " +
        "X-Vellum-User-Id is cross-checked against stored platform_user_id",
    );
  } else {
    log.warn(
      "DISABLE_HTTP_AUTH is set but IS_PLATFORM is NOT — bypass is INACTIVE. " +
        "JWT validation runs as normal. Set IS_PLATFORM=true to opt into the " +
        "platform-managed auth model.",
    );
  }
}

/**
 * Build edge-auth guard functions that share a rate limiter and IP resolver.
 *
 * All three guards short-circuit on loopback peers. Beyond that:
 *
 *   - `requireEdgeAuth` — validates a JWT bearer token (aud=vellum-gateway)
 *     OR (when bypass is active) cross-checks X-Vellum-User-Id against the
 *     stored platform_user_id credential.
 *   - `requireEdgeAuthWithScope` — same, plus a scope-profile check on the
 *     decoded JWT. Under the platform bypass, scope is enforced upstream by
 *     vembda; the gateway only verifies the cross-checked user id.
 *   - `requireEdgeGuardianAuth` — same pattern, additionally requires the
 *     authenticated principal to match the bound guardian.
 */
export function createAuthMiddleware(
  authRateLimiter: AuthRateLimiter,
  getClientIp: GetClientIp,
) {
  /**
   * Cross-check `X-Vellum-User-Id` against the stored
   * `vellum:platform_user_id` credential. Used by all three guards under the
   * platform-managed bypass. Returns null on success, or a 4xx/5xx Response.
   */
  async function requirePlatformUserHeader(
    req: Request,
  ): Promise<Response | null> {
    const headerUserId = req.headers.get("x-vellum-user-id");
    if (!headerUserId) {
      log.warn(
        { path: new URL(req.url).pathname },
        "Edge auth rejected: missing X-Vellum-User-Id (platform bypass active)",
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
        "Edge auth: platform_user_id credential lookup failed",
      );
      return Response.json({ error: "Service Unavailable" }, { status: 503 });
    }
    if (!storedUserId) {
      log.warn(
        { path: new URL(req.url).pathname },
        "Edge auth rejected: no platform_user_id stored on this assistant",
      );
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    if (storedUserId !== headerUserId) {
      log.warn(
        { path: new URL(req.url).pathname },
        "Edge auth rejected: X-Vellum-User-Id does not match stored platform_user_id",
      );
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    return null;
  }

  /**
   * Validate a JWT bearer token (aud=vellum-gateway) for client-facing routes.
   * Loopback peers (127.0.0.0/8, ::1) auto-pass without a token.
   */
  async function requireEdgeAuth(
    req: Request,
    server?: Server<unknown>,
  ): Promise<Response | null> {
    if (server && isLoopbackPeer(server, req)) return null;
    if (isPlatformAuthBypassActive()) {
      return requirePlatformUserHeader(req);
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
   * Validate a JWT bearer token and check that its scope profile includes the
   * required scope. Loopback peers bypass JWT validation. Under the platform
   * bypass, scope is enforced upstream by vembda — the gateway only confirms
   * the user id.
   */
  async function requireEdgeAuthWithScope(
    req: Request,
    scope: Scope,
    server?: Server<unknown>,
  ): Promise<Response | null> {
    if (server && isLoopbackPeer(server, req)) return null;
    if (isPlatformAuthBypassActive()) {
      return requirePlatformUserHeader(req);
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
   * Two auth modes:
   *
   *   1. Platform-managed (DISABLE_HTTP_AUTH + IS_PLATFORM): caller's identity
   *      is asserted via X-Vellum-User-Id cross-checked against the stored
   *      `vellum:platform_user_id` credential.
   *   2. Default: validate the edge JWT, require an actor principal, assert it
   *      matches the bound guardian's principal id.
   *
   * Loopback peers bypass both checks.
   */
  async function requireEdgeGuardianAuth(
    req: Request,
    server?: Server<unknown>,
  ): Promise<Response | null> {
    if (server && isLoopbackPeer(server, req)) return null;
    if (isPlatformAuthBypassActive()) {
      return requirePlatformUserHeader(req);
    }
    return requireEdgeGuardianAuthByActorPrincipal(req);
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
