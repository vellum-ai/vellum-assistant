/**
 * Backwards-compat helpers for daemon version asymmetry.
 *
 * The web app always serves the latest bundle from Vellum's infra,
 * but the daemon ("assistant") side can be running any version the
 * user has installed locally. New web features routinely ship before
 * every daemon out there has been upgraded — so the web app needs to
 * detect the daemon's version and either light up the new code path
 * or fall back to whatever the daemon understood before.
 *
 * This directory is the centralized home for all such gates. Every
 * module here is delete-on-sight the day we solve serving the matching
 * web bundle per assistant version. Until then, group all of the
 * "if daemon < X.Y.Z, do the old thing" logic here so we can grep for
 * `lib/backwards-compat` to find everything that can go away.
 *
 * Conventions:
 * - File per feature area (e.g. `flag-query-freshness.ts`).
 * - Each file's module-level docstring names the minimum daemon version
 *   it gates against and what the old vs. new behavior looks like.
 * - Use `assistantSupports(version, minVersion)` for the gate so semver
 *   parsing + pre-release stripping is consistent across modules.
 */
import { compareParsed, parseSemver } from "@/utils/semver.js";

/**
 * Returns `true` when the active assistant's daemon version is at or
 * above the given minimum.
 *
 * - Returns `false` when `version` is `null` or unparseable (we fall
 *   back to the old behavior until identity resolves).
 * - Pre-release suffixes on the patch version are ignored: `0.8.5-rc.1`
 *   counts as `0.8.5`. Testers on RCs get the new path the moment the
 *   patch version bumps.
 */
export function assistantSupports(
  version: string | null,
  minVersion: string,
): boolean {
  if (!version) return false;
  const parsed = parseSemver(version);
  const min = parseSemver(minVersion);
  if (!parsed || !min) return false;
  return compareParsed({ ...parsed, pre: null }, min) >= 0;
}
