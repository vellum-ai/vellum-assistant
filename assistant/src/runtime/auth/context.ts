/**
 * AuthContext builder — combines sub parsing and scope resolution into
 * a normalized AuthContext that downstream code can consume without
 * knowing about JWT internals.
 */

import { resolveScopeProfile } from './scopes.js';
import { parseSub } from './subject.js';
import type { AuthContext, TokenClaims } from './types.js';

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
 */
export function buildAuthContext(claims: TokenClaims): BuildAuthContextResult {
  const subResult = parseSub(claims.sub);
  if (!subResult.ok) {
    return { ok: false, reason: subResult.reason };
  }

  const scopes = resolveScopeProfile(claims.scope_profile);

  const context: AuthContext = {
    subject: claims.sub,
    principalType: subResult.principalType,
    assistantId: subResult.assistantId,
    actorPrincipalId: subResult.actorPrincipalId,
    sessionId: subResult.sessionId,
    scopeProfile: claims.scope_profile,
    scopes,
    policyEpoch: claims.policy_epoch,
  };

  return { ok: true, context };
}
