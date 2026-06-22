/**
 * Test-only utilities for seeding the feature flag override cache.
 *
 * Replaces the removed `_setOverridesForTesting` export from
 * `assistant-feature-flags.ts`. Lives here (not in the source module)
 * because production modules should not expose test backdoors.
 *
 * No source-module imports
 * ------------------------
 * This file has ZERO imports from `src/`. It accesses the feature flag
 * cache's state via the shared `globalThis.vellumAssistant.featureFlagCache`
 * slot that `src/config/feature-flag-cache.ts` also reads/writes. The slot
 * shape is duplicated here on purpose: keeping this file off the
 * production import graph is what protects the test preload from a
 * broken `node_modules` symlink (DB ghost #3). The two declarations MUST
 * stay in sync — if you change one, change the other.
 */

// Mirrors `src/config/feature-flag-cache.ts`. Duplicated by design — see
// the "No source-module imports" section above.
type FlagSlot = {
  overrides: Record<string, boolean | string> | null;
  fromGateway: boolean;
};

type VellumAssistantNamespace = {
  featureFlagCache?: FlagSlot;
};

function flagSlot(): FlagSlot {
  const g = globalThis as { vellumAssistant?: VellumAssistantNamespace };
  const ns = (g.vellumAssistant ??= {});
  return (ns.featureFlagCache ??= { overrides: null, fromGateway: false });
}

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
  overrides: Record<string, boolean | string>,
): void {
  const s = flagSlot();
  s.overrides = { ...overrides };
  s.fromGateway = true;
}
