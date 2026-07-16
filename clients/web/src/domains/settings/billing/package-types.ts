/**
 * Local type stubs for the Pro package catalog, mirroring the `ProPackage`
 * OpenAPI schema introduced in vellum-assistant-platform PR #9200.
 *
 * The platform exposes named, versioned Pro plan packages (Mighty / Super /
 * Ultra) as presets of the existing Pro line items (machine/storage/credit
 * tiers + base fee). These types are additive to `ProPlan` — the generated
 * `ProPlan` type will gain a `packages?: ProPackage[]` field once #9200
 * merges and the OpenAPI client is regenerated. Until then, callers read
 * `packages` defensively via the `ProPlanWithPackages` helper.
 *
 * Schema source: `ProPackage` component in `django/openapi_schemas/platform.yaml`.
 */

export interface ProPackage {
  key: string;
  name: string;
  description: string;
  version: number;
  machine_tier: string | null;
  storage_tier: string;
  credit_tier: string | null;
  machine_size: string | null;
  storage_gib: number;
  credits_usd: number | null;
  include_platform_fee: boolean;
  base_price_cents: number;
  machine_price_cents: number;
  storage_price_cents: number;
  credit_price_cents: number;
  total_price_cents: number;
}

/**
 * Catalog display order (mirrors `PRO_PACKAGES` insertion order from
 * `django/app/domain_models/constants.py`):
 *   mighty → super → ultra
 */
export const PACKAGE_ORDER = ["mighty", "super", "ultra"] as const;

/**
 * Local fallback presets, mirroring `PRO_PACKAGES` from platform PR #9200
 * (`django/app/domain_models/constants.py`). The API only returns `packages`
 * when the `pro-packages` LaunchDarkly flag is on; when it's off (or the
 * array is otherwise empty) callers fall back to these so the recommended
 * upgrade always has something to show.
 */
export const PACKAGE_PRESETS: ProPackage[] = [
  {
    key: "mighty",
    name: "Mighty",
    description:
      "10 GB of storage and $25 in monthly credits on the standard machine.",
    version: 1,
    machine_tier: null,
    storage_tier: "xs",
    credit_tier: "credits_25",
    machine_size: null,
    storage_gib: 10,
    credits_usd: 25,
    include_platform_fee: false,
    base_price_cents: 4000,
    machine_price_cents: 0,
    storage_price_cents: 0,
    credit_price_cents: 0,
    total_price_cents: 4000,
  },
  {
    key: "super",
    name: "Super",
    description: "Medium machine, 30 GB of storage, and $45 in monthly credits.",
    version: 1,
    machine_tier: "medium",
    storage_tier: "s",
    credit_tier: "credits_45",
    machine_size: "medium",
    storage_gib: 30,
    credits_usd: 45,
    include_platform_fee: true,
    base_price_cents: 10000,
    machine_price_cents: 0,
    storage_price_cents: 0,
    credit_price_cents: 0,
    total_price_cents: 10000,
  },
  {
    key: "ultra",
    name: "Ultra",
    description: "Large machine, 60 GB of storage, and $115 in monthly credits.",
    version: 1,
    machine_tier: "large",
    storage_tier: "m",
    credit_tier: "credits_115",
    machine_size: "large",
    storage_gib: 60,
    credits_usd: 115,
    include_platform_fee: true,
    base_price_cents: 20000,
    machine_price_cents: 0,
    storage_price_cents: 0,
    credit_price_cents: 0,
    total_price_cents: 20000,
  },
];

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
