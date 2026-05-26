/**
 * Test-only utilities for seeding the feature flag override cache.
 *
 * Replaces the removed `_setOverridesForTesting` export from
 * `assistant-feature-flags.ts`. Lives here (not in the source module)
 * because production modules should not expose test backdoors, and
 * because importing from this file pulls only the stdlib-only
 * `feature-flag-cache.ts` — never the resolver's pino + IPC chain.
 *
 * See `src/config/feature-flag-cache.ts` for the underlying state contract.
 */

import { setCachedOverrides } from "../config/feature-flag-cache.js";

/**
 * Synchronously seed the feature flag override cache for the current test.
 *
 * Sets the cache to a clone of `overrides` and marks it as
 * gateway-populated, so subsequent `initFeatureFlagOverrides()` calls are
 * no-ops (preventing the production retry loop from running during tests).
 *
 * Tests that want the gateway IPC retry path to actually run should not
 * call this — they should leave the cache empty or call
 * `clearFeatureFlagOverridesCache()` from `assistant-feature-flags.ts`.
 */
export function setOverridesForTesting(
  overrides: Record<string, boolean>,
): void {
  setCachedOverrides(overrides, { fromGateway: true });
}
