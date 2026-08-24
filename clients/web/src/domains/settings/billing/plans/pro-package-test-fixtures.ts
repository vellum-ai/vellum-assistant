/**
 * Shared `ProPackage` fixtures for the plan/package suites and the
 * package-switch story file.
 *
 * Source of truth: `PRO_PACKAGES` (with `PRO_MACHINE_TIERS`,
 * `PRO_STORAGE_TIERS`, `PRO_CREDIT_TIERS` and `PRO_BASE_PRICE_USD`) in the
 * platform repo's `django/app/domain_models/constants.py`, priced by
 * `_build_packages` in `django/app/billing/plan_views.py`: the total is
 * `base + machine + storage + credits`, and `base` is zero unless the package
 * carries the platform fee. Re-check both when a package changes — a value
 * here the catalog does not have is a bug in the fixture, not a scenario.
 *
 * One factory per catalog package keeps the surfaces from drifting into subtly
 * different "typical package" shapes — and from disagreeing on where
 * `ProPackage` is imported from.
 */

import type { ProPackage } from "@/domains/settings/billing/package-types";

/** The catalog's Mighty package; override per scenario. */
export function makeProPackage(
  overrides: Partial<ProPackage> = {},
): ProPackage {
  return {
    key: "mighty",
    name: "Mighty",
    description:
      "10 GB of storage and monthly Mighty Usage on the standard machine.",
    version: 1,
    machine_tier: null,
    storage_tier: "xs",
    credit_tier: "credits_25",
    machine_size: null,
    storage_gib: 10,
    credits_usd: 25,
    usage_label: "Mighty Usage",
    // Mighty is the one package that skips the base platform fee.
    include_platform_fee: false,
    base_price_cents: 0,
    machine_price_cents: 0,
    storage_price_cents: 500,
    credit_price_cents: 2500,
    total_price_cents: 3000,
    ...overrides,
  };
}

/** The catalog's Super package; override per scenario. */
export function makeSuperPackage(
  overrides: Partial<ProPackage> = {},
): ProPackage {
  return makeProPackage({
    key: "super",
    name: "Super",
    description: "Medium machine, 30 GB of storage, and monthly Super Usage.",
    machine_tier: "medium",
    storage_tier: "s",
    credit_tier: "credits_45",
    machine_size: "medium",
    storage_gib: 30,
    credits_usd: 45,
    usage_label: "Super Usage",
    include_platform_fee: true,
    base_price_cents: 1000,
    machine_price_cents: 3500,
    storage_price_cents: 1000,
    credit_price_cents: 4500,
    total_price_cents: 10000,
    ...overrides,
  });
}

/** The catalog's Ultra package; override per scenario. */
export function makeUltraPackage(
  overrides: Partial<ProPackage> = {},
): ProPackage {
  return makeProPackage({
    key: "ultra",
    name: "Ultra",
    description: "Large machine, 60 GB of storage, and monthly Ultra Usage.",
    machine_tier: "large",
    storage_tier: "m",
    credit_tier: "credits_115",
    machine_size: "large",
    storage_gib: 60,
    credits_usd: 115,
    usage_label: "Ultra Usage",
    include_platform_fee: true,
    base_price_cents: 1000,
    machine_price_cents: 6000,
    storage_price_cents: 1500,
    credit_price_cents: 11500,
    total_price_cents: 20000,
    ...overrides,
  });
}
