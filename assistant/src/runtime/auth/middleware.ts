/**
 * JWT bearer auth middleware for the runtime HTTP server.
 *
 * Extracts `Authorization: Bearer <token>`, verifies the JWT, and
 * builds an AuthContext from the claims.
 *
 * Accepts two JWT audiences:
 *   - `vellum-daemon` — primary audience, used by the gateway's runtime
 *     proxy after token exchange.
 *   - `vellum-gateway` — fallback audience, used by direct local clients
 *     (e.g., the macOS app's SettingsStore) that hold a guardian-issued
 *     JWT but call daemon endpoints directly without routing through the
 *     gateway's runtime proxy. Both daemon and gateway share the same
 *     HMAC signing key (~/.vellum/protected/actor-token-signing-key),
 *     so the signature is valid regardless of audience.
 *
 * Replaces both the legacy bearer shared-secret check and the
 * actor-token HMAC middleware with a single JWT verification path.
 *
 * In dev mode (DISABLE_HTTP_AUTH + VELLUM_UNSAFE_AUTH_BYPASS), JWT
 * verification is skipped and a synthetic AuthContext is constructed
 * so downstream code always has a typed context to consume.
 */

import { isHttpAuthDisabled } from "../../config/env.js";
import { getLogger } from "../../util/logger.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../assistant-scope.js";
import { verifyHostBrowserCapability } from "../capability-tokens.js";
import { extractBearerToken } from "../middleware/auth.js";
import { buildAuthContext } from "./context.js";
import { resolveScopeProfile } from "./scopes.js";
import { verifyToken } from "./token-service.js";
import type { AuthContext } from "./types.js";

const log = getLogger("auth-middleware");

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type AuthenticateResult =
  | { ok: true; context: AuthContext }
  | { ok: false; response: Response };

// ---------------------------------------------------------------------------
// Dev bypass synthetic context
// ---------------------------------------------------------------------------

/**
 * Construct a synthetic AuthContext for dev mode when auth is bypassed.
 * Grants the broadest profile so all routes are accessible during
 * local development.
 */
function buildDevBypassContext(): AuthContext {
  return {
    subject: `actor:${DAEMON_INTERNAL_ASSISTANT_ID}:dev-bypass`,
    principalType: "actor",
    assistantId: DAEMON_INTERNAL_ASSISTANT_ID,
    actorPrincipalId: "dev-bypass",
    scopeProfile: "actor_client_v1",
    scopes: resolveScopeProfile("actor_client_v1"),
    policyEpoch: Number.MAX_SAFE_INTEGER,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Authenticate an incoming HTTP request via JWT bearer token.
 *
 * Returns an AuthContext on success, or an error Response on failure.
 * The caller should return the error Response directly to the client.
 */
export function authenticateRequest(req: Request): AuthenticateResult {
  // Dev bypass: skip JWT verification entirely
  if (isHttpAuthDisabled()) {
    return { ok: true, context: buildDevBypassContext() };
  }

  const path = new URL(req.url).pathname;

  const rawToken = extractBearerToken(req);
  if (!rawToken) {
    log.warn(
      { reason: "missing_token", path },
      "Auth denied: missing Authorization header",
    );
    return {
      ok: false,
      response: Response.json(
        {
          error: {
            code: "UNAUTHORIZED",
            message: "Missing Authorization header",
          },
        },
        { status: 401 },
      ),
    };
  }

  // Verify the JWT — prefer vellum-daemon audience (gateway-proxied requests
  // and daemon-minted tokens), but also accept vellum-gateway audience for
  // direct local clients (macOS SettingsStore) that hold a guardian-issued JWT
  // and call daemon endpoints without routing through the gateway runtime proxy.
  let verifyResult = verifyToken(rawToken, "vellum-daemon");
  if (
    !verifyResult.ok &&
    verifyResult.reason?.startsWith("audience_mismatch")
  ) {
    verifyResult = verifyToken(rawToken, "vellum-gateway");
    // Normalize gateway-audience claims to daemon context so that
    // buildAuthContext applies the same assistantId normalization
    // (aud=vellum-daemon → assistantId='self') that gateway-exchanged
    // tokens receive. Without this rewrite, the external assistant ID
    // from the guardian-issued JWT would leak into daemon-internal
    // scoping (storage keys, routing), violating the invariant
    // documented in context.ts:30-33.
    if (verifyResult.ok) {
      verifyResult = {
        ok: true,
        claims: { ...verifyResult.claims, aud: "vellum-daemon" },
      };
    }
  }
  if (!verifyResult.ok) {
    // Stale policy epoch gets a specific error code so clients can refresh
    if (verifyResult.reason === "stale_policy_epoch") {
      log.warn(
        { reason: "stale_policy_epoch", path },
        "Auth denied: stale policy epoch",
      );
      return {
        ok: false,
        response: Response.json(
          {
            error: {
              code: "refresh_required",
              message: "Token policy epoch is stale; refresh required",
            },
          },
          { status: 401 },
        ),
      };
    }

    log.warn(
      { reason: verifyResult.reason, path },
      "Auth denied: JWT verification failed",
    );
    return {
      ok: false,
      response: Response.json(
        {
          error: {
            code: "UNAUTHORIZED",
            message: `Invalid token: ${verifyResult.reason}`,
          },
        },
        { status: 401 },
      ),
    };
  }

  // Build normalized AuthContext from verified claims
  const contextResult = buildAuthContext(verifyResult.claims);
  if (!contextResult.ok) {
    log.warn(
      { reason: contextResult.reason, path, sub: verifyResult.claims.sub },
      "Auth denied: invalid JWT claims",
    );
    return {
      ok: false,
      response: Response.json(
        {
          error: {
            code: "UNAUTHORIZED",
            message: `Invalid token claims: ${contextResult.reason}`,
          },
        },
        { status: 401 },
      ),
    };
  }

  return { ok: true, context: contextResult.context };
}

// ---------------------------------------------------------------------------
// Capability-token-aware auth for /v1/host-browser-result
// ---------------------------------------------------------------------------

/**
 * Build a synthetic AuthContext from a verified host_browser capability
 * claim. The resulting context is shaped to look like an
 * `actor_client_v1` actor so downstream route policy (which requires
 * `approval.write`) and `requireBoundGuardian` (which compares
 * `actorPrincipalId` against the bound guardian) both accept it.
 *
 * The capability token already carries its own HMAC-checked expiry, so
 * there is no policy-epoch gate to apply here — we pin `policyEpoch` to
 * `Number.MAX_SAFE_INTEGER` the same way the dev-bypass context does.
 */
function buildCapabilityAuthContext(guardianId: string): AuthContext {
  return {
    subject: `actor:${DAEMON_INTERNAL_ASSISTANT_ID}:${guardianId}`,
    principalType: "actor",
    assistantId: DAEMON_INTERNAL_ASSISTANT_ID,
    actorPrincipalId: guardianId,
    scopeProfile: "actor_client_v1",
    scopes: resolveScopeProfile("actor_client_v1"),
    policyEpoch: Number.MAX_SAFE_INTEGER,
  };
}

/**
 * Authenticate a request that is allowed to present either a JWT or a
 * host_browser capability token. This is the auth entry point for
 * `/v1/host-browser-result` POST specifically — the chrome extension
 * stores a capability token (minted by the
 * `/v1/browser-extension-pair` flow) rather than a daemon JWT, so the
 * POST fallback used when the `/v1/browser-relay` WebSocket is
 * unavailable would otherwise 401 through the JWT-only
 * `authenticateRequest` path.
 *
 * Order of operations (mirrors `handleBrowserRelayUpgrade`):
 *   1. Extract the bearer token. Missing header → 401.
 *   2. Try `verifyHostBrowserCapability(token)` first. If it succeeds,
 *      derive `guardianId` from the capability claims and synthesize an
 *      AuthContext.
 *   3. Otherwise fall through to the standard JWT path so daemon-minted
 *      JWTs (gateway-proxied or direct) continue to work as a
 *      regression-safe compatibility path.
 *
 * Dev bypass (`isHttpAuthDisabled()`) is honored the same way as
 * `authenticateRequest` — we delegate to it directly to pick up the
 * shared synthetic dev-bypass context.
 */
export async function authenticateHostBrowserResultRequest(
  req: Request,
): Promise<AuthenticateResult> {
  if (isHttpAuthDisabled()) {
    return { ok: true, context: buildDevBypassContext() };
  }

  const rawToken = extractBearerToken(req);
  if (!rawToken) {
    log.warn(
      { reason: "missing_token", path: "/v1/host-browser-result" },
      "Host browser result auth denied: missing Authorization header",
    );
    return {
      ok: false,
      response: Response.json(
        {
          error: {
            code: "UNAUTHORIZED",
            message: "Missing Authorization header",
          },
        },
        { status: 401 },
      ),
    };
  }

  // 1) Capability-token path (self-hosted default). The chrome
  //    extension presents the token it received from the native
  //    messaging pair flow. We derive `actorPrincipalId` from the
  //    capability claims directly — the claims are HMAC-signed by the
  //    same daemon so there is no cross-tenant risk.
  const capabilityClaims = await verifyHostBrowserCapability(rawToken);
  if (capabilityClaims) {
    return {
      ok: true,
      context: buildCapabilityAuthContext(capabilityClaims.guardianId),
    };
  }

  // 2) JWT compatibility path. Fall back to the existing daemon/gateway
  //    JWT verification so cloud callers and any legacy self-hosted
  //    clients still holding a daemon JWT continue to work. Any 401
  //    emitted here already includes the JWT-specific reason.
  return authenticateRequest(req);
}
