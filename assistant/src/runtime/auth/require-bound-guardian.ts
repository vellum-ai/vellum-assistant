import { isHttpAuthDisabled } from "../../config/env.js";
import { httpError } from "../http-errors.js";
import { matchesBoundGuardian } from "./owner-caller.js";
import type { AuthContext } from "./types.js";

/**
 * Verify the actor from AuthContext is the bound guardian for the vellum channel.
 * Sources the guardian from the gateway binding and fails closed when the
 * gateway is unreachable (null list). Returns an error Response if not
 * authorized, or null if allowed.
 */
export async function requireBoundGuardian(
  authContext: AuthContext,
): Promise<Response | null> {
  // Dev bypass: when auth is disabled, skip guardian binding check
  // (mirrors enforcePolicy dev bypass in route-policy.ts)
  if (isHttpAuthDisabled()) {
    return null;
  }
  // Missing actor id, an unreadable binding (gateway unreachable), a
  // non-matching principal, and a non-active row all fail closed inside
  // `matchesBoundGuardian`. Cached read: these routes are host-proxy result
  // callbacks on an active session, and this preserves their established
  // semantics. The wake surface asks for a fresh binding explicitly.
  if (await matchesBoundGuardian(authContext.actorPrincipalId)) {
    return null;
  }
  return httpError(
    "FORBIDDEN",
    "Actor is not the bound guardian for this channel",
    403,
  );
}
