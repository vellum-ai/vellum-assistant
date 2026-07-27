/**
 * Shared `ProPackage` factory for the plan/package suites and the
 * package-switch story file.
 *
 * The defaults are the Mighty catalog shape; pass overrides for another tier.
 * One factory keeps the three surfaces from drifting into subtly different
 * "typical package" shapes — and from disagreeing on where `ProPackage` is
 * imported from.
 */

import type { ProPackage } from "@/domains/settings/billing/package-types";

/** A fully-typed Pro package with Mighty defaults; override per tier. */
export function makeProPackage(
  overrides: Partial<ProPackage> = {},
): ProPackage {
  return {
    key: "mighty",
    name: "Mighty",
    description: "Small machine, 15 GB of storage, and $25 in monthly credits.",
    version: 1,
    machine_tier: null,
    storage_tier: "s",
    credit_tier: "credits_25",
    machine_size: null,
    storage_gib: 15,
    credits_usd: 25,
    include_platform_fee: true,
    base_price_cents: 2000,
    machine_price_cents: 0,
    storage_price_cents: 500,
    credit_price_cents: 2500,
    total_price_cents: 5000,
    ...overrides,
  };
}
