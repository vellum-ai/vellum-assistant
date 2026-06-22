/**
 * Module-level cache for resolved feature flag override values.
 *
 * Lives in its own module (rather than alongside the resolver in
 * `assistant-feature-flags.ts`) so test code can read/write the cache
 * without going through `assistant-feature-flags.ts` — which transitively
 * pulls `util/logger.js` (pino) and the gateway IPC client. Stdlib-only
 * by design: this file must remain safe to import from the test
 * preload's load-time chain, where a broken `node_modules` symlink has
 * historically tripped the env override (see DB ghost #3,
 * /workspace/journal/2026-05-25-db-ghost-3-recovery.md).
 *
 * State is held on `globalThis.vellumAssistant.featureFlagCache` so test
 * helpers in `__tests__/` can read/write it WITHOUT importing this
 * module — they declare the same slot shape locally and access the
 * globalThis namespace directly. See
 * `__tests__/feature-flag-test-helpers.ts` for the test-side mirror;
 * the slot shape MUST stay in sync between the two.
 *
 * Both `overrides` and `fromGateway` were previously module-level `let`
 * bindings inside `assistant-feature-flags.ts`. The semantics are
 * preserved exactly: `overrides === null` means "no fetch has populated
 * the cache yet"; `fromGateway === true` means "the cache is
 * authoritative — `initFeatureFlagOverrides()` should not clobber it".
 *
 * Consumers:
 *   - `assistant-feature-flags.ts` (resolver — reads/writes via gateway fetch)
 *   - `__tests__/feature-flag-test-helpers.ts` (seeds for tests, via globalThis)
 */

type FlagSlot = {
  overrides: Record<string, boolean | string> | null;
  fromGateway: boolean;
};

type VellumAssistantNamespace = {
  featureFlagCache?: FlagSlot;
};

function slot(): FlagSlot {
  const g = globalThis as { vellumAssistant?: VellumAssistantNamespace };
  const ns = (g.vellumAssistant ??= {});
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
