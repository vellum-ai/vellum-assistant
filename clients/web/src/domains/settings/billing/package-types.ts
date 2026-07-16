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
