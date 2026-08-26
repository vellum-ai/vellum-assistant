import { useQuery } from "@tanstack/react-query";

import { organizationsBillingPlansRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import type { CreditTierEnum, ProPlan } from "@/generated/api/types.gen";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import type { CheckoutIntent } from "@/lib/billing/checkout-intent";
import { creditTierKeyUsd, findCreditTier } from "@/lib/billing/credit-tiers";

/**
 * A credit bundle change as monthly dollar amounts. Both sides always carry a
 * number: "No extra credits" is $0, not an absent side.
 *
 * Each side also carries the bundle's catalog label ("Mighty Usage", the
 * Stripe product name, so it matches the invoice line), which the
 * `obscure-credits` rendering shows in place of the dollar rate. `null` marks
 * the explicit no-bundle side, worded by the caller; `undefined` a bundle the
 * catalog can't label, which the obscured chip leaves unstated.
 */
export interface CreditsChange {
  fromUsd: number;
  toUsd: number;
  fromLabel: string | null | undefined;
  toLabel: string | null | undefined;
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
 * The catalog label for a tier, with the same null-tier reading as
 * `creditTierUsd`: a null tier is the explicit "No extra credits" choice
 * (`null` here), and a tier the catalog doesn't list has no label to give
 * (`undefined`); unlike the dollars, a key like `credits_115` carries no
 * wording to fall back to.
 */
function creditTierLabel(
  proPlan: ProPlan | undefined,
  tier: CreditTierEnum | null,
): string | null | undefined {
  if (tier == null) {
    return null;
  }
  return findCreditTier(proPlan, tier)?.label;
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
  let toLabel: string | null | undefined;
  if (intent.kind === "package") {
    const pkg = proPlan.packages.find((p) => p.key === intent.packageKey);
    const tier = findCreditTier(proPlan, pkg?.credit_tier);
    toUsd = pkg?.credits_usd ?? tier?.credits_usd;
    // The package's customer-facing usage_label is preferred: a tier label
    // can be dollar-denominated ("$50 credits/mo"), which the obscured chip
    // must never render. The tier label covers a package without one.
    toLabel = pkg?.usage_label ?? tier?.label ?? undefined;
  } else {
    const tier = findCreditTier(proPlan, intent.creditTier);
    toUsd = tier?.credits_usd;
    toLabel = tier?.label;
  }

  // The base plan bundles no credits, so the from-side is the explicit
  // no-bundle choice, not an unlabelled one.
  return toUsd != null ? { fromUsd: 0, toUsd, fromLabel: null, toLabel } : null;
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
  return {
    fromUsd,
    toUsd,
    fromLabel: creditTierLabel(proPlan, change.fromTier),
    toLabel: creditTierLabel(proPlan, change.toTier),
  };
}
