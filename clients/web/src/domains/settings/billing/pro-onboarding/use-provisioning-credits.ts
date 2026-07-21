import { useQuery } from "@tanstack/react-query";

import { organizationsBillingPlansRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import type { ProPlan } from "@/generated/api/types.gen";
import type { CheckoutIntent } from "@/lib/billing/checkout-intent";

/**
 * Resolves the human-readable monthly-credit label for the purchased plan from
 * the shared plan catalog, so the provisioning takeover can render a
 * `0 → {credits}` chip for the base→pro upgrade. Reads the same query
 * `plans-page.tsx` uses, so React Query dedupes when the takeover follows a page
 * that already fetched it. Returns null while the catalog loads, when the intent
 * carries no credits, or when the label can't be resolved. Display-only.
 */
export function useProvisioningCredits(
  intent: CheckoutIntent | null,
): string | null {
  const { data } = useQuery(organizationsBillingPlansRetrieveOptions());

  if (intent == null) {
    return null;
  }

  const proPlan = data?.plans.find((p): p is ProPlan => p.id === "pro");
  if (proPlan == null) {
    return null;
  }
  const creditTiers = proPlan.credit_tiers ?? [];

  if (intent.kind === "package") {
    const pkg = proPlan.packages.find((p) => p.key === intent.packageKey);
    const label = creditTiers.find((t) => t.tier === pkg?.credit_tier)?.label;
    if (label != null) {
      return label;
    }
    return pkg?.credits_usd != null ? `${pkg.credits_usd} credits` : null;
  }

  if (intent.creditTier != null) {
    return creditTiers.find((t) => t.tier === intent.creditTier)?.label ?? null;
  }

  return null;
}
