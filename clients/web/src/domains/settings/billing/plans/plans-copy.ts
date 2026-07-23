/**
 * Static marketing copy for the View Plans takeover, keyed by plan tier.
 *
 * Only the per-tier prose lives here — tagline, CTA label, the caption under
 * the price, and any feature rows that aren't derived from the catalog. Price,
 * storage, credits, and machine size all come from the live plan catalog at
 * render time. A catalog package whose key has no entry here falls back to its
 * own display name plus the catalog-derived feature rows.
 */

import type { PlanTierKey } from "@/domains/settings/billing/plan-tier-meta";

export interface PlanTierCopy {
  /** Supporting line under the plan name; sized for two lines in the card. */
  tagline: string;
  /** Full-width CTA label (replaced by "Current Plan" on the active tier). */
  cta: string;
  /** Small caption rendered under the price. */
  priceCaption: string;
  /** Marks the recommended tier; plans-page keys the light/white card off this. */
  recommended?: boolean;
  /** Feature rows appended after the catalog-derived rows. */
  extraFeatures?: readonly string[];
}

export const PLAN_TIER_COPY: Record<PlanTierKey, PlanTierCopy> = {
  free: {
    tagline: "Get to know your assistant",
    cta: "Start Free",
    priceCaption: "Forever",
  },
  mighty: {
    tagline: "Empower your assistant to level you up.",
    cta: "Power Up",
    priceCaption: "Billed monthly",
    recommended: true,
  },
  super: {
    tagline: "Give your assistant real muscle to help you grow",
    cta: "Go Super",
    priceCaption: "Billed monthly",
    extraFeatures: ["Assistant email and subdomain"],
  },
  ultra: {
    tagline:
      "Our most powerful assistant. There's nothing you can't tackle together",
    cta: "Unleash Ultra",
    priceCaption: "Billed monthly",
    extraFeatures: ["Assistant email and subdomain"],
  },
};

/** Copy for a tier key, or `undefined` for a catalog key with no entry. */
export function getPlanTierCopy(key: string): PlanTierCopy | undefined {
  return PLAN_TIER_COPY[key as PlanTierKey];
}

/** CTA label for a tier that sits below the user's current tier. */
export function downgradeLabel(name: string): string {
  return `Downgrade to ${name}`;
}
