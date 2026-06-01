/**
 * Route policy enforcement for the runtime HTTP server.
 *
 * Each `RouteDefinition` carries its own `policy: RoutePolicy | null`
 * declaring the scopes + principal types it requires. The HTTP server
 * passes that policy to `enforcePolicy()` per request; the IPC route
 * adapter reads the same field when serializing the schema for the
 * gateway's IPC proxy.
 *
 * When auth is bypassed in dev mode, policies are still evaluated for
 * type safety but always allow the request through.
 */

import { isHttpAuthDisabled } from "../../config/env.js";
import { getLogger } from "../../util/logger.js";
import type { AuthContext, PrincipalType, Scope } from "./types.js";

const log = getLogger("route-policy");

// ---------------------------------------------------------------------------
// Policy definition
// ---------------------------------------------------------------------------

export interface RoutePolicy {
  requiredScopes: Scope[];
  allowedPrincipalTypes: PrincipalType[];
}

// ---------------------------------------------------------------------------
// Principal-type bundles
//
// These constants exist so each route can declare its policy inline
// without re-spelling the same 4-element array hundreds of times. They
// are also the canonical "who can call this" categories — adding a new
// principal type to one of these constants flows automatically to every
// route that uses it.
// ---------------------------------------------------------------------------

/**
 * Default principals for actor-facing endpoints — the actor making
 * the request, gateway/daemon service principals proxying for it,
 * and CLI/IPC-local callers.
 */
export const ACTOR_PRINCIPALS: PrincipalType[] = [
  "actor",
  "svc_gateway",
  "svc_daemon",
  "local",
];

/**
 * Principals for gateway-only internal endpoints — webhooks, OAuth
 * callbacks, and other platform-orchestrated control-plane calls
 * that should never originate from a user.
 */
export const GATEWAY_PRINCIPALS: PrincipalType[] = ["svc_gateway"];

/**
 * Principals for IPC-local endpoints — CLI commands and other
 * daemon-resident callers that talk to the runtime over the local
 * IPC socket.
 */
export const LOCAL_PRINCIPALS: PrincipalType[] = ["local"];

// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------

/**
 * Enforce a route policy against the AuthContext.
 *
 * Returns an error Response if the request should be denied, or null
 * if the request is allowed to proceed.
 *
 * When `policy` is null the route is explicitly unprotected (e.g.
 * health, debug) — always allowed.
 *
 * When auth is bypassed (dev mode), the policy is still checked
 * against the synthetic context for type safety but always returns
 * null (allowed).
 */
export function enforcePolicy(
  endpoint: string,
  policy: RoutePolicy | null,
  authCtx: AuthContext,
): Response | null {
  if (!policy) {
    // No policy declared — unprotected endpoint (e.g. health, debug)
    return null;
  }

  // Dev bypass: log but allow everything through
  if (isHttpAuthDisabled()) {
    return null;
  }

  // Check principal type
  if (!policy.allowedPrincipalTypes.includes(authCtx.principalType)) {
    log.warn(
      {
        endpoint,
        principalType: authCtx.principalType,
        allowed: policy.allowedPrincipalTypes,
      },
      "Route policy denied: principal type not allowed",
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

  // Check required scopes
  for (const scope of policy.requiredScopes) {
    if (!authCtx.scopes.has(scope)) {
      log.warn(
        { endpoint, missingScope: scope, principalType: authCtx.principalType },
        "Route policy denied: missing required scope",
      );
      return Response.json(
        {
          error: {
            code: "FORBIDDEN",
            message: `Missing required scope: ${scope}`,
          },
        },
        { status: 403 },
      );
    }
  }

  return null;
}
