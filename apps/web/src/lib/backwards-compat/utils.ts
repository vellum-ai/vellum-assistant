/**
 * Backwards-compat helpers for assistant version asymmetry.
 *
 * The web app always serves the latest bundle from Vellum's infra,
 * but the assistant side can be running any version the
 * user has installed locally. New web features routinely ship before
 * every assistant out there has been upgraded, so the web app needs to
 * detect the assistant's version and either light up the new code path
 * or fall back to whatever the assistant understood before.
 *
 * This directory is the centralized home for all such gates. Every
 * module here is delete-on-sight the day we solve serving the matching
 * web bundle per assistant version. Until then, group all of the
 * "if assistant < X.Y.Z, do the old thing" logic here so we can grep
 * for `lib/backwards-compat` to find everything that can go away.
 *
 * Conventions:
 * - File per feature area (e.g. `flag-query-freshness.ts`).
 * - Each file's module-level `MIN_VERSION` declares the minimum
 *   assistant version it gates against and what the old vs. new
 *   behavior looks like.
 * - Use `useAssistantSupports(MIN_VERSION)` for the gate so semver
 *   parsing + pre-release stripping is consistent across modules.
 *   (Hook name follows React's rules-of-hooks since the active
 *   assistant version is read off the identity store.)
 */
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { compareParsed, parseSemver } from "@/utils/semver";
import { whenStoreState } from "@/utils/when-store-state";

/**
 * Returns `true` when the active assistant's version is at or above
 * `minVersion`. Subscribes to the identity store via the `use.version()`
 * selector so React components re-render when the version flips.
 *
 * - Returns `false` while the identity store has no version yet (we
 *   fall back to the old behavior until identity resolves).
 * - Pre-release suffixes on the patch version are ignored: `0.8.5-rc.1`
 *   counts as `0.8.5`. Testers on RCs get the new path the moment the
 *   patch version bumps.
 * - Unparseable versions (either side) return `false`.
 */
export function useAssistantSupports(minVersion: string): boolean {
  const version = useAssistantIdentityStore.use.version();
  return supportsVersion(version, minVersion);
}

/**
 * Non-hook variant of `useAssistantSupports`: reads the version
 * snapshot via `useAssistantIdentityStore.getState()` so it's safe to
 * call from non-hook contexts (event handlers, async ops, request
 * builders). React-render paths that should re-render when the version
 * flips must use `useAssistantSupports` instead.
 *
 * Semantics match `useAssistantSupports`: returns `false` until the
 * version is hydrated, ignores pre-release suffixes, and returns
 * `false` for unparseable versions.
 */
export function assistantSupports(minVersion: string): boolean {
  const version = useAssistantIdentityStore.getState().version;
  return supportsVersion(version, minVersion);
}

function supportsVersion(
  version: string | null | undefined,
  minVersion: string,
): boolean {
  if (!version) return false;
  const parsed = parseSemver(version);
  const min = parseSemver(minVersion);
  if (!parsed || !min) return false;
  return compareParsed({ ...parsed, pre: null }, min) >= 0;
}

/**
 * Upper bound for {@link whenAssistantVersionKnown}. The identity fetch
 * that hydrates the version resolves in well under a second against a
 * reachable daemon; this only caps the wait when the endpoint is
 * unreachable, in which case the gated write would fail regardless.
 */
export const VERSION_RESOLUTION_TIMEOUT_MS = 5_000;

/**
 * Resolves once the active assistant's version is known (non-null), or
 * after `timeoutMs` if it never hydrates.
 *
 * The version snapshot starts `null` and is hydrated asynchronously by
 * the identity fetch (`useAssistantIdentityInit`) — onboarding even
 * seeds a usable assistant with a still-`null` version. The sync
 * `assistantSupports` snapshot collapses "unknown" and "known-old" into
 * a single `false`, which is safe for read paths that fall back to a
 * universally-understood legacy route, but NOT for write paths whose
 * legacy fallback mutates state in a way a newer assistant ignores.
 * Such writes await this first so the gate is read against a resolved
 * version rather than the conservative `false`-on-unknown default.
 */
export function whenAssistantVersionKnown(
  timeoutMs: number = VERSION_RESOLUTION_TIMEOUT_MS,
): Promise<void> {
  return whenStoreState(
    useAssistantIdentityStore,
    (state) => Boolean(state.version),
    { timeoutMs },
  );
}
