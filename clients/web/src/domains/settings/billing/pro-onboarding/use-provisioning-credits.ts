import { useQuery } from "@tanstack/react-query";

import { organizationsBillingPlansRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import type {
  CreditTier,
  CreditTierEnum,
  PlanCatalogEntry,
  ProPlan,
} from "@/generated/api/types.gen";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import type { CheckoutIntent } from "@/lib/billing/checkout-intent";

/**
 * Finds a Pro plan's `credit_tiers` entry for a tier — the single source of the
 * credit-tier lookup shared by the label helpers here and the plans-page custom
 * row summary. Returns undefined for a null/undefined tier or when the tier
 * can't be resolved (no Pro plan, no matching tier).
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
 * Resolves a credit tier's catalog label from the Pro plan's `credit_tiers`.
 * Returns null for a null/undefined tier or when the tier can't be resolved
 * (catalog still loading, no Pro plan, no matching tier).
 */
function creditTierLabel(
  plans: PlanCatalogEntry[] | undefined,
  tier: CreditTierEnum | null | undefined,
): string | null {
  const proPlan = plans?.find((p): p is ProPlan => p.id === "pro");
  return findCreditTier(proPlan, tier)?.label ?? null;
}

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

  if (intent.kind === "package") {
    const pkg = proPlan.packages.find((p) => p.key === intent.packageKey);
    const label = findCreditTier(proPlan, pkg?.credit_tier)?.label;
    if (label != null) {
      return label;
    }
    return pkg?.credits_usd != null ? `${pkg.credits_usd} credits` : null;
  }

  return creditTierLabel(data?.plans, intent.creditTier);
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

  return creditTierLabel(data?.plans, creditTier);
}
