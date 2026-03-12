/**
 * Scope resolution and policy enforcement for OAuth providers.
 *
 * Pure module (no side effects, no I/O) that resolves the final set of
 * scopes for an OAuth flow based on the provider profile's scope policy.
 */

import type { OAuthScopePolicy } from "./connect-types.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type ScopeResolutionResult =
  | { ok: true; scopes: string[] }
  | { ok: false; error: string; allowedScopes?: string[] };

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Resolve the final set of scopes for an OAuth flow.
 *
 * - If `requestedScopes` is undefined or empty, returns the provider's
 *   `defaultScopes`.
 * - Otherwise, starts with `defaultScopes` and validates each additional
 *   requested scope against the provider's `scopePolicy`.
 * - Returns a deduplicated union of default + approved requested scopes.
 */
/** Minimal shape needed by the scope resolver. */
export interface ScopeResolverInput {
  service: string;
  defaultScopes: string[];
  scopePolicy: OAuthScopePolicy;
}

export function resolveScopes(
  profile: ScopeResolverInput,
  requestedScopes?: string[],
): ScopeResolutionResult {
  const { defaultScopes, scopePolicy, service } = profile;

  // No requested scopes — use defaults
  if (!requestedScopes || requestedScopes.length === 0) {
    return { ok: true, scopes: [...defaultScopes] };
  }

  const defaultSet = new Set(defaultScopes);
  const finalScopes = new Set(defaultScopes);

  for (const scope of requestedScopes) {
    // Already in defaults — no policy check needed
    if (defaultSet.has(scope)) {
      continue;
    }

    // Check forbidden list first
    if (scopePolicy.forbiddenScopes.includes(scope)) {
      return {
        ok: false,
        error: `Scope '${scope}' is forbidden for ${service}`,
      };
    }

    // Additional scopes not allowed at all
    if (!scopePolicy.allowAdditionalScopes) {
      return {
        ok: false,
        error: `Additional scopes are not allowed for ${service}. Only the default scopes may be used.`,
        allowedScopes: [...defaultScopes],
      };
    }

    // Additional scopes allowed, but this one isn't in the optional list
    if (!scopePolicy.allowedOptionalScopes.includes(scope)) {
      return {
        ok: false,
        error: `Scope '${scope}' is not in the allowed optional scopes for ${service}`,
        allowedScopes: [...defaultScopes, ...scopePolicy.allowedOptionalScopes],
      };
    }

    // Passed all checks — include it
    finalScopes.add(scope);
  }

  return { ok: true, scopes: [...finalScopes] };
}
