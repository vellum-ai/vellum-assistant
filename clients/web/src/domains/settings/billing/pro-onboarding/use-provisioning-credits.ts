import { useQuery } from "@tanstack/react-query";

import { organizationsBillingPlansRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import type { CreditTierEnum, ProPlan } from "@/generated/api/types.gen";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
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
  const orgReady = useIsOrgReady();
  // Without a ready org the request carries no `Vellum-Organization-Id` and
  // fails, caching a rejection that would leave the chip unresolved once the
  // org does hydrate. The sibling provisioning queries gate the same way.
  const { data } = useQuery({
    ...organizationsBillingPlansRetrieveOptions(),
    enabled: orgReady && intent != null,
  });

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

/**
 * Resolves a single credit tier's human-readable label from the shared plan
 * catalog, for the in-place resize takeover's terminal "credits updated" chip.
 * Mirrors `useProvisioningCredits`'s custom-intent resolution but takes the tier
 * directly — the resize path threads the just-applied tier, not a stashed
 * checkout intent. Returns null while the catalog loads, when no tier is given
 * (e.g. the "No extra credits" choice), or when the tier can't be resolved.
 * Display-only.
 */
export function useCreditTierLabel(
  creditTier: CreditTierEnum | null | undefined,
): string | null {
  const orgReady = useIsOrgReady();
  // Gate the same way the sibling provisioning queries do: without a ready org
  // the request carries no `Vellum-Organization-Id` and fails.
  const { data } = useQuery({
    ...organizationsBillingPlansRetrieveOptions(),
    enabled: orgReady && creditTier != null,
  });

  if (creditTier == null) {
    return null;
  }
  const proPlan = data?.plans.find((p): p is ProPlan => p.id === "pro");
  return (
    proPlan?.credit_tiers?.find((t) => t.tier === creditTier)?.label ?? null
  );
}
