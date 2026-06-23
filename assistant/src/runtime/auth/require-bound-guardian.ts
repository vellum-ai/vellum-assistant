import { isHttpAuthDisabled } from "../../config/env.js";
import {
  getGuardianDelivery,
  guardianForChannel,
} from "../../contacts/guardian-delivery-reader.js";
import { httpError } from "../http-errors.js";
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
  if (!authContext.actorPrincipalId) {
    return httpError(
      "FORBIDDEN",
      "Actor is not the bound guardian for this channel",
      403,
    );
  }
  const guardians = await getGuardianDelivery({ channelTypes: ["vellum"] });
  if (!guardians) {
    // Gateway unreachable — fail closed.
    return httpError(
      "FORBIDDEN",
      "Actor is not the bound guardian for this channel",
      403,
    );
  }
  const guardian = guardianForChannel(guardians, "vellum");
  if (guardian && guardian.principalId === authContext.actorPrincipalId) {
    return null;
  }
  return httpError(
    "FORBIDDEN",
    "Actor is not the bound guardian for this channel",
    403,
  );
}
