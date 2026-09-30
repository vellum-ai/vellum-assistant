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

import { isTrustClass, TRUST_CLASS_VALUES } from "@vellumai/gateway-client";

import { isHttpAuthDisabled } from "../../config/env.js";
import { getLogger } from "../../util/logger.js";
import { isContactTrustClass, type TrustClass } from "../trust-class.js";
import { isNarrowScopeProfile } from "./scopes.js";
import type { AuthContext, PrincipalType, Scope } from "./types.js";

const log = getLogger("route-policy");

// ---------------------------------------------------------------------------
// Policy definition
// ---------------------------------------------------------------------------

export interface RoutePolicy {
  requiredScopes: Scope[];
  allowedPrincipalTypes: PrincipalType[];
  /** Trust classes whose turn may call this route. Absent means guardian only. */
  allowedTrustClasses?: TrustClass[];
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
// Trust-class bundles
//
// The second "who can call this" axis: principal type names what kind of
// credential arrived, trust class names whose turn it speaks for.
// ---------------------------------------------------------------------------

/** Only the guardian's turn. The default for a route naming no classes. */
export const GUARDIAN_ONLY: TrustClass[] = ["guardian"];

/**
 * The guardian's turn and an admitted contact's, derived rather than listed
 * so a new contact class joins it automatically. Both contact classes belong:
 * they differ on admission, not on what they may do once admitted. Keeping an
 * unverified contact out is the admission floor's job, not a route's.
 */
export const CONTACT_ALLOWED: TrustClass[] = TRUST_CLASS_VALUES.filter(
  (trustClass) => trustClass === "guardian" || isContactTrustClass(trustClass),
);

/**
 * Whether an actor of `trustClass` may call a route carrying `policy`.
 *
 * A null policy and an absent `allowedTrustClasses` both resolve to
 * {@link GUARDIAN_ONLY}. A value outside the vocabulary is refused: a field
 * statically typed {@link TrustClass} can still carry a legacy or wire-sourced
 * value.
 */
export function trustClassAllowed(
  policy: RoutePolicy | null,
  trustClass: TrustClass | (string & {}) | undefined,
): boolean {
  if (typeof trustClass !== "string" || !isTrustClass(trustClass)) {
    return false;
  }
  return (policy?.allowedTrustClasses ?? GUARDIAN_ONLY).includes(trustClass);
}

// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------

/**
 * Enforce a route policy against the AuthContext.
 *
 * Returns an error Response if the request should be denied, or null
 * if the request is allowed to proceed.
 *
 * A route naming no scope (`policy` null, or empty `requiredScopes`) is
 * unprotected (e.g. health, debug) for a broad profile, and closed to a
 * narrow one. {@link isNarrowScopeProfile} classifies every profile, so a new
 * one has to be classified there rather than compiling into either answer.
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
  // Dev bypass: log but allow everything through
  if (isHttpAuthDisabled()) {
    return null;
  }

  // A single-route grant reaches only a route that names its scope, so an
  // unprotected one refuses it rather than admitting any valid token.
  if (
    (policy?.requiredScopes.length ?? 0) === 0 &&
    isNarrowScopeProfile(authCtx.scopeProfile)
  ) {
    log.warn(
      { endpoint, scopeProfile: authCtx.scopeProfile },
      "Route policy denied: grant is scoped to a single route",
    );
    return Response.json(
      {
        error: {
          code: "FORBIDDEN",
          message: "This grant is not permitted for this endpoint",
        },
      },
      { status: 403 },
    );
  }

  if (!policy) {
    // An endpoint with no policy declared is unprotected (e.g. health, debug).
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
