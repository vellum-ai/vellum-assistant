/**
 * AuthContext builder — combines sub parsing and scope resolution into
 * a normalized AuthContext that downstream code can consume without
 * knowing about JWT internals.
 */

import { DAEMON_INTERNAL_ASSISTANT_ID } from "../assistant-scope.js";
import { resolveScopeProfile } from "./scopes.js";
import { parseSub } from "./subject.js";
import type { AuthContext, TokenClaims } from "./types.js";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type BuildAuthContextResult =
  | { ok: true; context: AuthContext }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build a normalized AuthContext from verified JWT claims.
 *
 * Parses the sub claim and resolves the scope profile into a concrete
 * set of scopes. Returns a failure result if the sub is malformed.
 *
 * When the token audience is `vellum-daemon`, the assistantId is forced
 * to DAEMON_INTERNAL_ASSISTANT_ID ('self') regardless of what the JWT
 * sub encodes. Daemon code must never derive internal scoping from
 * externally-provided assistant IDs.
 */
export function buildAuthContext(claims: TokenClaims): BuildAuthContextResult {
  const subResult = parseSub(claims.sub);
  if (!subResult.ok) {
    return { ok: false, reason: subResult.reason };
  }

  const scopes = resolveScopeProfile(claims.scope_profile);

  // Daemon-audience tokens always scope to the internal assistant ID,
  // preventing external assistant IDs from leaking into daemon-side
  // storage and routing.
  const assistantId =
    claims.aud === "vellum-daemon"
      ? DAEMON_INTERNAL_ASSISTANT_ID
      : subResult.assistantId;

  const context: AuthContext = {
    subject: claims.sub,
    principalType: subResult.principalType,
    assistantId,
    actorPrincipalId: subResult.actorPrincipalId,
    sessionId: subResult.conversationId,
    scopeProfile: claims.scope_profile,
    scopes,
    policyEpoch: claims.policy_epoch,
  };

  return { ok: true, context };
}
