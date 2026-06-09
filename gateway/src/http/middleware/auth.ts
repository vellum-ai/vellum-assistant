import type { Server } from "bun";

import { isActorTokenRevoked } from "../../auth/actor-token-revocation.js";
import { findVellumGuardian } from "../../auth/guardian-bootstrap.js";
import { resolveScopeProfile } from "../../auth/scopes.js";
import { parseSub } from "../../auth/subject.js";
import { validateEdgeToken } from "../../auth/token-exchange.js";
import type { Scope, TokenClaims } from "../../auth/types.js";
import { AuthFallbackCountTracker } from "../../auth-fallback-count-tracker.js";
import { AuthFallbackLogThrottle } from "../../auth-fallback-log-throttle.js";
import type { AuthRateLimiter } from "../../auth-rate-limiter.js";
import { credentialKey } from "../../credential-key.js";
import { readCredential } from "../../credential-reader.js";
import { getLogger } from "../../logger.js";
import { isLoopbackPeer } from "../../util/is-loopback-address.js";

const log = getLogger("auth");

// Suppresses repeat "legacy loopback fallback" warnings: each (guard, path)
// logs at most once per cooldown window so the rollout signal stays visible
// without per-request noise. Process-lifetime — createAuthMiddleware is invoked
// per request, so this state can't live in its closure.
const loopbackFallbackLogThrottle = new AuthFallbackLogThrottle();

// Exact, unthrottled count of every loopback fallback, keyed by
// (guard, path, failureKind). Drained and shipped to the daemon telemetry route
// by AuthFallbackReporter. Process-lifetime singleton for the same reason as the
// throttle above; exported so the reporter and tests share the one instance.
export const loopbackFallbackCountTracker = new AuthFallbackCountTracker();

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
 * All three guards retain a legacy loopback fallback for self-hosted local
 * clients. Each fallback endpoint and failure kind logs once per cooldown
 * window (see `loopbackFallbackLogThrottle`) so callers still missing or
 * failing auth are visible during rollout without per-request log noise. The
 * platform-managed bypass is checked first, so this fallback only applies in
 * default mode.
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
  trustProxy = false,
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
   * Loopback peers (127.0.0.0/8, ::1) fall back when auth is missing,
   * malformed, or invalid.
   */
  async function requireEdgeAuth(
    req: Request,
    server?: Server<unknown>,
  ): Promise<Response | null> {
    if (isPlatformAuthBypassActive()) {
      return requirePlatformUserHeader(req);
    }
    const hasAuthHeader = hasAuthorizationHeader(req);
    const token = extractBearerToken(req);
    if (token) {
      return validateEdgeBearer(req, token, server);
    }
    if (hasAuthHeader) {
      return rejectMalformedAuthorization(req, "Edge auth", server, "edge");
    }
    return rejectMissingAuthorization(req, "Edge auth", server, "edge");
  }

  /**
   * Validate a JWT bearer token and check that its scope profile includes the
   * required scope. Loopback peers fall back when auth is missing, malformed,
   * invalid, or under-scoped. Under the platform bypass, scope is enforced
   * upstream by vembda — the gateway only confirms the user id.
   */
  async function requireEdgeAuthWithScope(
    req: Request,
    scope: Scope,
    server?: Server<unknown>,
  ): Promise<Response | null> {
    if (isPlatformAuthBypassActive()) {
      return requirePlatformUserHeader(req);
    }
    const hasAuthHeader = hasAuthorizationHeader(req);
    const token = extractBearerToken(req);
    if (token) {
      return validateScopedEdgeBearer(req, token, scope, server);
    }
    if (hasAuthHeader) {
      return rejectMalformedAuthorization(
        req,
        "Scoped edge auth",
        server,
        "edge-scoped",
        { scope },
      );
    }
    return rejectMissingAuthorization(
      req,
      "Scoped edge auth",
      server,
      "edge-scoped",
      { scope },
    );
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
   * Loopback peers fall back when guardian auth is missing, malformed, invalid,
   * or not authorized.
   */
  async function requireEdgeGuardianAuth(
    req: Request,
    server?: Server<unknown>,
  ): Promise<Response | null> {
    if (isPlatformAuthBypassActive()) {
      return requirePlatformUserHeader(req);
    }
    return requireEdgeGuardianAuthByActorPrincipal(req, server);
  }

  function validateEdgeBearer(
    req: Request,
    token: string,
    server?: Server<unknown>,
  ): Response | null {
    const result = validateEdgeToken(token);
    if (!result.ok) {
      if (
        allowLegacyLoopbackFallback(req, server, "edge", {
          authFailure: "token_validation_failed",
          reason: result.reason,
        })
      ) {
        return null;
      }
      authRateLimiter.recordFailure(getClientIp());
      log.warn(
        { path: new URL(req.url).pathname, reason: result.reason },
        "Edge auth rejected: token validation failed",
      );
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    return rejectIfActorTokenRevoked(req, token, result.claims);
  }

  function validateScopedEdgeBearer(
    req: Request,
    token: string,
    scope: Scope,
    server?: Server<unknown>,
  ): Response | null {
    const result = validateEdgeToken(token);
    if (!result.ok) {
      if (
        allowLegacyLoopbackFallback(req, server, "edge-scoped", {
          authFailure: "token_validation_failed",
          reason: result.reason,
          scope,
        })
      ) {
        return null;
      }
      authRateLimiter.recordFailure(getClientIp());
      log.warn(
        { path: new URL(req.url).pathname, scope, reason: result.reason },
        "Scoped edge auth rejected: token validation failed",
      );
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const revoked = rejectIfActorTokenRevoked(req, token, result.claims);
    if (revoked) return revoked;
    const scopes = resolveScopeProfile(result.claims.scope_profile);
    if (!scopes.has(scope)) {
      if (
        allowLegacyLoopbackFallback(req, server, "edge-scoped", {
          authFailure: "insufficient_scope",
          scope,
        })
      ) {
        return null;
      }
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    return null;
  }

  function rejectMissingAuthorization(
    req: Request,
    label: string,
    server: Server<unknown> | undefined,
    guard: string,
    extra?: Record<string, unknown>,
  ): Response | null {
    if (
      allowLegacyLoopbackFallback(req, server, guard, {
        authFailure: "missing_authorization",
        ...extra,
      })
    ) {
      return null;
    }
    authRateLimiter.recordFailure(getClientIp());
    log.warn(
      { path: new URL(req.url).pathname, ...extra },
      `${label} rejected: missing Authorization header`,
    );
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  function rejectMalformedAuthorization(
    req: Request,
    label: string,
    server: Server<unknown> | undefined,
    guard: string,
    extra?: Record<string, unknown>,
  ): Response | null {
    if (
      allowLegacyLoopbackFallback(req, server, guard, {
        authFailure: "malformed_authorization",
        ...extra,
      })
    ) {
      return null;
    }
    authRateLimiter.recordFailure(getClientIp());
    log.warn(
      { path: new URL(req.url).pathname, ...extra },
      `${label} rejected: malformed Authorization header`,
    );
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  /**
   * Reject a validated edge token whose actor record has been revoked. Returns
   * a 401 response when revoked, or null to continue. Fail-open for non-actor
   * and unrecorded tokens (see isActorTokenRevoked).
   */
  function rejectIfActorTokenRevoked(
    req: Request,
    token: string,
    claims: TokenClaims,
  ): Response | null {
    if (!isActorTokenRevoked(token, claims)) return null;
    authRateLimiter.recordFailure(getClientIp());
    log.warn(
      { path: new URL(req.url).pathname },
      "Edge auth rejected: actor token revoked",
    );
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  function allowLegacyLoopbackFallback(
    req: Request,
    server: Server<unknown> | undefined,
    guard: string,
    extra?: Record<string, unknown>,
  ): boolean {
    // When a trusted reverse proxy is declared, judge loopback-ness by the
    // real client IP (first X-Forwarded-For entry) rather than the raw socket
    // peer. A same-host proxy/tunnel always connects over 127.0.0.1, so without
    // this a proxied remote caller would be misclassified as local and granted
    // the loopback grace period. trustProxy defaults false, so direct-loopback
    // local clients (no X-Forwarded-For) are unaffected. See is-loopback-address.ts.
    if (!server || !isLoopbackPeer(server, req, { trustProxy })) return false;

    const path = new URL(req.url).pathname;
    const failureKind =
      typeof extra?.authFailure === "string"
        ? extra.authFailure
        : "unspecified";

    // Count every fallback (unthrottled) for telemetry. The throttle below only
    // governs log volume — it must not gate the count, or the data undercounts.
    loopbackFallbackCountTracker.increment(guard, path, failureKind);

    if (
      loopbackFallbackLogThrottle.shouldLog(`${guard} ${path} ${failureKind}`)
    ) {
      const peer = server.requestIP(req);
      log.warn(
        {
          path,
          guard,
          peerIp: peer?.address,
          authFallback: "legacy_loopback",
          ...extra,
        },
        "Gateway auth allowed via legacy loopback fallback after gateway auth did not succeed (throttled to one log per endpoint per hour)",
      );
    }
    return true;
  }

  /**
   * Default path — validate JWT, require actor principal, assert it matches
   * the bound vellum guardian.
   */
  async function requireEdgeGuardianAuthByActorPrincipal(
    req: Request,
    server?: Server<unknown>,
  ): Promise<Response | null> {
    const token = extractBearerToken(req);
    if (!token) {
      if (
        allowLegacyLoopbackFallback(req, server, "edge-guardian", {
          authFailure: hasAuthorizationHeader(req)
            ? "malformed_authorization"
            : "missing_authorization",
        })
      ) {
        return null;
      }
      authRateLimiter.recordFailure(getClientIp());
      log.warn(
        { path: new URL(req.url).pathname },
        "Guardian edge auth rejected: missing or malformed Authorization header",
      );
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const result = validateEdgeToken(token);
    if (!result.ok) {
      if (
        allowLegacyLoopbackFallback(req, server, "edge-guardian", {
          authFailure: "token_validation_failed",
          reason: result.reason,
        })
      ) {
        return null;
      }
      authRateLimiter.recordFailure(getClientIp());
      log.warn(
        { path: new URL(req.url).pathname, reason: result.reason },
        "Guardian edge auth rejected: token validation failed",
      );
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const revoked = rejectIfActorTokenRevoked(req, token, result.claims);
    if (revoked) return revoked;
    const parsed = parseSub(result.claims.sub);
    if (
      !parsed.ok ||
      parsed.principalType !== "actor" ||
      !parsed.actorPrincipalId
    ) {
      if (
        allowLegacyLoopbackFallback(req, server, "edge-guardian", {
          authFailure: "non_actor_principal",
        })
      ) {
        return null;
      }
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
      if (
        allowLegacyLoopbackFallback(req, server, "edge-guardian", {
          authFailure: "guardian_mismatch",
        })
      ) {
        return null;
      }
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

function hasAuthorizationHeader(req: Request): boolean {
  return Boolean(req.headers.get("authorization")?.trim());
}
