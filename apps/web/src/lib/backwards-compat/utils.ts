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

/**
 * Returns `true` when the active assistant's version is at or above
 * `minVersion`.
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
  if (!version) return false;
  const parsed = parseSemver(version);
  const min = parseSemver(minVersion);
  if (!parsed || !min) return false;
  return compareParsed({ ...parsed, pre: null }, min) >= 0;
}
