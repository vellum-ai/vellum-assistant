import { useQuery } from "@tanstack/react-query";

import { organizationsBillingPlansRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import type {
  CreditTier,
  CreditTierEnum,
  ProPlan,
} from "@/generated/api/types.gen";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import type { CheckoutIntent } from "@/lib/billing/checkout-intent";
import { creditTierKeyUsd } from "@/lib/billing/credit-tiers";

/**
 * A credit bundle change as monthly dollar amounts. Both sides always carry a
 * number: "No extra credits" is $0, not an absent side.
 */
export interface CreditsChange {
  fromUsd: number;
  toUsd: number;
}

/**
 * The credit tiers an in-place plan change moves between. `null` on either side
 * is the explicit "No extra credits" choice.
 */
export interface CreditTierChange {
  fromTier: CreditTierEnum | null;
  toTier: CreditTierEnum | null;
}

/**
 * Finds a Pro plan's `credit_tiers` entry for a tier, the single source of the
 * credit-tier lookup shared by the dollar resolution here and the plans-page
 * custom row summary. Returns undefined for a null/undefined tier or when the
 * tier can't be resolved (no Pro plan, no matching tier).
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
 * The Pro plan from the shared plan catalog. Reads the same query
 * `plans-page.tsx` uses, so React Query dedupes when the takeover follows a page
 * that already fetched it.
 *
 * Without a ready org the request carries no `Vellum-Organization-Id` and fails,
 * caching a rejection that would leave the chip unresolved once the org does
 * hydrate. The sibling provisioning queries gate the same way.
 */
function useProPlan(enabled: boolean): ProPlan | undefined {
  const orgReady = useIsOrgReady();
  const { data } = useQuery({
    ...organizationsBillingPlansRetrieveOptions(),
    enabled: orgReady && enabled,
  });
  return data?.plans.find((p): p is ProPlan => p.id === "pro");
}

/**
 * The monthly dollars a credit tier bundles. A null tier is the "No extra
 * credits" choice and costs nothing, and the catalog prices everything it
 * lists; a tier it doesn't falls back to the amount its key names. Anything
 * else stays unresolved, so the chip is dropped rather than rendering a wrong
 * number.
 */
function creditTierUsd(
  proPlan: ProPlan | undefined,
  tier: CreditTierEnum | null,
): number | null {
  if (tier == null) {
    return 0;
  }
  return findCreditTier(proPlan, tier)?.credits_usd ?? creditTierKeyUsd(tier);
}

/**
 * The credits a post-Stripe checkout buys, as a from-to dollar pair. The base
 * plan bundles none, so the from-side is $0. Returns null while the catalog
 * loads, when the intent carries no credits, or when the amount can't be
 * resolved, and the chip is omitted. Display-only.
 */
export function useProvisioningCredits(
  intent: CheckoutIntent | null,
): CreditsChange | null {
  const proPlan = useProPlan(intent != null);

  if (intent == null || proPlan == null) {
    return null;
  }

  let toUsd: number | null | undefined;
  if (intent.kind === "package") {
    const pkg = proPlan.packages.find((p) => p.key === intent.packageKey);
    toUsd =
      pkg?.credits_usd ??
      findCreditTier(proPlan, pkg?.credit_tier)?.credits_usd;
  } else {
    toUsd = findCreditTier(proPlan, intent.creditTier)?.credits_usd;
  }

  return toUsd != null ? { fromUsd: 0, toUsd } : null;
}

/**
 * The credits an in-place plan change moves between, as a from-to dollar pair.
 * Both endpoints come from the tiers the plans page captured before the change
 * landed, so the chip states the move rather than the outcome. Returns null when
 * no credit change is threaded or when either side can't be resolved, and the
 * chip is omitted. Display-only.
 */
export function useResizeCreditsChange(
  change: CreditTierChange | null | undefined,
): CreditsChange | null {
  const proPlan = useProPlan(change != null);

  if (change == null) {
    return null;
  }
  const fromUsd = creditTierUsd(proPlan, change.fromTier);
  const toUsd = creditTierUsd(proPlan, change.toTier);
  if (fromUsd == null || toUsd == null) {
    return null;
  }
  return { fromUsd, toUsd };
}
