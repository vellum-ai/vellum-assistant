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
import { compareParsed, comparePreRelease, parseSemver } from "@/utils/semver";
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
 * - `dev` pre-releases (e.g. `0.10.0-dev.202606211252.5cf8576`) are
 *   treated as AHEAD of the stable release with the same base version
 *   (the opposite of strict semver) — they contain unreleased commits.
 *   Two dev builds with the same base compare by their pre-release
 *   string (which encodes a timestamp). This lets gates target a
 *   specific dev build by passing the exact version string as
 *   `minVersion`.
 * - Unparseable versions (either side) return `false`.
 */
export function useAssistantSupports(minVersion: string): boolean {
  const version = useAssistantIdentityStore.use.version();
  return supportsVersion(version, minVersion);
}

/**
 * Assistant-scoped variant of `useAssistantSupports`: returns `true` only
 * when the active assistant's version meets `minVersion` AND the identity
 * store's version was fetched for `ownerAssistantId` — the assistant that
 * owns whatever the caller is gating (a transcript, a live voice session).
 *
 * Both the version and its owner are read from the identity store — a
 * single atomic snapshot (`setIdentity` writes them in the same store
 * update) — so the version can never be checked against a different
 * assistant's feature surface, even transiently during an assistant
 * switch. Comparing against the identity store's own `assistantId` —
 * rather than `activeAssistantId` from the resolved-assistants store —
 * keeps the check race-free: the two stores update at different times, so
 * a cross-store pairing could briefly validate against the previous
 * assistant's version.
 *
 * Conservative on mismatch or unknown: returns `false` when
 * `ownerAssistantId` is null/undefined, when the identity store's version
 * was fetched for a different assistant (or has no owner recorded), while
 * no version has hydrated yet, when the version is unparseable, or when
 * it falls below `minVersion`.
 */
export function useAssistantScopedSupports(
  minVersion: string,
  ownerAssistantId: string | null | undefined,
): boolean {
  const identityAssistantId = useAssistantIdentityStore.use.assistantId();
  const versionSupported = useAssistantSupports(minVersion);
  return (
    versionSupported &&
    ownerAssistantId != null &&
    ownerAssistantId === identityAssistantId
  );
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
  // Compare base versions (major.minor.patch) first, ignoring
  // pre-release suffixes. If the bases differ, the higher base wins.
  const baseCmp = compareParsed(
    { ...parsed, pre: null },
    { ...min, pre: null },
  );
  if (baseCmp !== 0) return baseCmp > 0;
  // Base versions are equal. Dev pre-releases (e.g.
  // `0.10.0-dev.202606211252.5cf8576`) are development builds AHEAD of
  // the stable release with the same base — they contain unreleased
  // commits on top of it. So a dev build of 0.10.0 is newer than the
  // 0.10.0 stable release, not older (the opposite of strict semver).
  const versionIsDev = parsed.pre !== null && parsed.pre.startsWith("dev");
  const minIsDev = min.pre !== null && min.pre.startsWith("dev");
  if (versionIsDev && minIsDev) {
    // Two dev builds with the same base compare by their pre-release
    // string, which encodes a timestamp (dev.YYYYMMDDHHMM.sha).
    return comparePreRelease(parsed.pre!, min.pre!) >= 0;
  }
  if (versionIsDev !== minIsDev) {
    // Dev is ahead of stable with the same base.
    return versionIsDev;
  }
  // Neither is dev — existing convention: strip pre-release suffixes,
  // equal base versions count as supported (rc/beta/alpha testers get
  // the new path the moment the patch version bumps).
  return true;
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
