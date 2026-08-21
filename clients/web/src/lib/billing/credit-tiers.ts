import type { CreditTier, ProPlan } from "@/generated/api/types.gen";

/**
 * Finds a Pro plan's `credit_tiers` entry for a tier, the single source of the
 * credit-tier lookup shared by the billing dollar resolutions, the plans-page
 * custom row summary, and the usage-balance denominator. Returns undefined for
 * a null/undefined tier or when the tier can't be resolved (no Pro plan, no
 * matching tier).
 */
export function findCreditTier(
  proPlan: ProPlan | undefined,
  tier: string | null | undefined,
): CreditTier | undefined {
  if (tier == null) {
    return undefined;
  }
  return proPlan?.credit_tiers?.find((t) => t.tier === tier);
}

/**
 * The monthly dollar amount a credit tier key names. Tier keys are shaped
 * `credits_<usd>`, so a held or legacy tier the plan catalog no longer lists
 * still carries its own amount and can be priced without it. Returns null for
 * any key not in that shape, and callers decide what to show instead.
 */
export function creditTierKeyUsd(
  tier: string | null | undefined,
): number | null {
  const usd = tier?.match(/^credits_(\d+)$/)?.[1];
  return usd != null ? Number(usd) : null;
}
