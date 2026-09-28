/**
 * Cache for resolved feature-flag overrides.
 *
 * State lives on `globalThis.vellumAssistant.featureFlagCache` so test
 * infrastructure can seed it through the ambient namespace without importing
 * production modules into the preload-time graph.
 *
 * `overrides === null` means no fetch has populated the cache.
 * `fromGateway === true` prevents initialization from replacing an
 * authoritative fetched or test-seeded value.
 */

function slot(): VellumFeatureFlagCache {
  const ns = (globalThis.vellumAssistant ??= {});
  return (ns.featureFlagCache ??= { overrides: null, fromGateway: false });
}

/** Read the current override cache. `null` means not yet populated. */
export function getCachedOverrides(): Record<string, boolean | string> | null {
  return slot().overrides;
}

/**
 * True when the cache was populated by either a gateway IPC fetch or by a
 * test helper. Used by `initFeatureFlagOverrides()` to short-circuit a
 * second fetch (e.g. when a CLI entry point runs after the daemon has
 * already initialized) and by tests to prevent the retry loop from
 * clobbering preseeded state.
 */
export function isCachedFromGateway(): boolean {
  return slot().fromGateway;
}

/**
 * Replace the cache with a clone of `overrides`. The `fromGateway` flag
 * is set by the caller — production callers pass `true` after a
 * successful gateway fetch; test helpers also pass `true` so subsequent
 * `initFeatureFlagOverrides()` calls are no-ops.
 */
export function setCachedOverrides(
  overrides: Record<string, boolean | string>,
  options: { fromGateway: boolean },
): void {
  const s = slot();
  s.overrides = { ...overrides };
  s.fromGateway = options.fromGateway;
}

/**
 * Drop the cache. The next `loadOverrides()` returns an empty record (so
 * flag checks fall through to registry defaults) and the next
 * `initFeatureFlagOverrides()` re-fetches from the gateway.
 */
export function clearCachedOverrides(): void {
  const s = slot();
  s.overrides = null;
  s.fromGateway = false;
}
