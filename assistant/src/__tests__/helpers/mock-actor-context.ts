/**
 * Typed fixture factories for actor identity in tests.
 *
 * A fixture built here is a complete, type-checked `TrustContext` or
 * `AuthContext` with conservative defaults; a test overrides only the fields
 * its scenario is about, and the compiler guards the rest. Hand-rolled
 * literals cannot make that guarantee: a missing required field needs a cast
 * to satisfy the checker, and the cast then hides every other mistake in the
 * literal.
 *
 * Type-only imports keep this helper out of the runtime import graph, per the
 * test-machinery isolation rules in `assistant/CLAUDE.md`.
 */

import type { TrustContext } from "../../daemon/trust-context-types.js";
import type { AuthContext, Scope } from "../../runtime/auth/types.js";

/**
 * A complete `TrustContext`. Defaults to the guardian on the vellum channel;
 * pass overrides for anything the test cares about.
 */
export function mockTrustContext(
  overrides: Partial<TrustContext> = {},
): TrustContext {
  return {
    sourceChannel: "vellum",
    trustClass: "guardian",
    ...overrides,
  };
}

/**
 * A complete `AuthContext`. Defaults to a local principal with no scopes, the
 * conservative shape, so a test that forgets to opt in exercises the
 * restrictive branch rather than a silently permissive one.
 */
export function mockAuthContext(
  overrides: Partial<AuthContext> = {},
): AuthContext {
  return {
    subject: "local:self:test",
    principalType: "local",
    assistantId: "self",
    scopeProfile: "local_v1",
    scopes: new Set<Scope>(),
    policyEpoch: 0,
    ...overrides,
  };
}
