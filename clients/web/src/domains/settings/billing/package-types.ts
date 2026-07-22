/**
 * Helpers for the Pro package catalog — the named Pro plan presets
 * (Mighty / Super / Ultra) exposed as `ProPlan.packages` in the platform API
 * (vellum-assistant-platform #9200). The catalog is empty while the
 * `pro-packages` LaunchDarkly flag is off; callers no-op on an empty array.
 */

import type { ProPackage } from "@/generated/api/types.gen";

export type { ProPackage };

/**
 * Catalog display order (mirrors `PRO_PACKAGES` insertion order from
 * `django/app/domain_models/constants.py`):
 *   mighty → super → ultra
 */
export const PACKAGE_ORDER = ["mighty", "super", "ultra"] as const;

/** Tier keys in ascending order, base/free first. */
const TIER_RANK_ORDER = ["free", ...PACKAGE_ORDER] as const;

/**
 * Rank of a tier key across `free → mighty → super → ultra` (0..3). Unknown
 * keys return -1 so callers can treat them defensively.
 */
export function packageRank(key: string): number {
  return TIER_RANK_ORDER.indexOf(key as (typeof TIER_RANK_ORDER)[number]);
}

export type TierRelation = "current" | "downgrade" | "upgrade";

/**
 * Classify a target tier relative to the user's current tier. When the current
 * tier is unknown (null, or an unrecognized key), or the target tier is
 * unrecognized, the result defaults to "upgrade", preserving base-user
 * behavior and avoiding a false "downgrade" for keys this bundle doesn't know.
 */
export function tierRelation(
  currentTierKey: string | null,
  targetKey: string,
): TierRelation {
  if (currentTierKey === null) {
    return "upgrade";
  }
  const current = packageRank(currentTierKey);
  const target = packageRank(targetKey);
  if (current === -1 || target === -1) {
    return "upgrade";
  }
  if (target === current) {
    return "current";
  }
  return target < current ? "downgrade" : "upgrade";
}

/**
 * Given a current package key (or null for base/free), return the next
 * package up in the catalog ordering. Returns null if the user is already
 * on the highest package or no packages are available.
 */
export function nextPackageUp(
  packages: ProPackage[],
  currentKey: string | null,
): ProPackage | null {
  if (packages.length === 0) return null;

  const sorted = [...packages].sort(
    (a, b) =>
      PACKAGE_ORDER.indexOf(a.key as (typeof PACKAGE_ORDER)[number]) -
      PACKAGE_ORDER.indexOf(b.key as (typeof PACKAGE_ORDER)[number]),
  );

  if (!currentKey) return sorted[0];

  const idx = sorted.findIndex((p) => p.key === currentKey);
  if (idx === -1) return sorted[0];
  if (idx >= sorted.length - 1) return null;
  return sorted[idx + 1];
}
