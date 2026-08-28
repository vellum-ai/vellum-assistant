import { useQuery } from "@tanstack/react-query";

import { organizationsBillingPlansRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import type { CreditTierEnum, ProPlan } from "@/generated/api/types.gen";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import type { CheckoutIntent } from "@/lib/billing/checkout-intent";
import { findCreditTier } from "@/lib/billing/credit-tiers";

/**
 * The two sides of a credit bundle change, each as the catalog label the chip
 * renders ("Mighty Usage", the Stripe product name, so it matches the invoice
 * line). `null` marks the explicit no-bundle side, worded by the caller; an
 * `undefined` from-side is a bundle the catalog can't label, which the chip
 * leaves unstated.
 */
export interface CreditsChange {
  fromLabel: string | null | undefined;
  toLabel: string | null;
}

/**
 * The credit tiers an in-place plan change moves between. `null` on either side
 * is the explicit no-bundle choice.
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
 * The catalog label for a tier. A null tier is the explicit no-bundle choice
 * (`null` here), and a tier the catalog doesn't list has no label to give
 * (`undefined`): a key like `credits_115` carries no wording to fall back to.
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
 * The bundle labels a post-Stripe checkout's chip states. The base plan bundles
 * none, so the from-side is the explicit no-bundle choice. Returns null while
 * the catalog loads, when the intent carries no credits, and when the catalog
 * can't word the bundle bought, and the chip is omitted. Display-only.
 */
export function useProvisioningCredits(
  intent: CheckoutIntent | null,
): CreditsChange | null {
  const proPlan = useProPlan(intent != null);

  if (intent == null || proPlan == null) {
    return null;
  }

  let toLabel: string | undefined;
  if (intent.kind === "package") {
    const pkg = proPlan.packages.find((p) => p.key === intent.packageKey);
    // The package's customer-facing usage_label is preferred: a tier label
    // can be dollar-denominated ("$50 credits/mo"), which the chip must never
    // render. The tier label covers a package without one.
    toLabel =
      pkg?.usage_label ?? findCreditTier(proPlan, pkg?.credit_tier)?.label;
  } else {
    // A custom checkout without a bundle has no move to state, so an absent
    // tier resolves undefined and the chip is dropped, not worded as a
    // no-bundle side the way a resize's endpoint is.
    toLabel = findCreditTier(proPlan, intent.creditTier)?.label;
  }

  // The base plan bundles no credits, so the from-side is the explicit
  // no-bundle choice, not an unlabelled one.
  return toLabel !== undefined ? { fromLabel: null, toLabel } : null;
}

/**
 * The bundle labels an in-place plan change moves between. Both endpoints come
 * from the tiers the plans page captured before the change landed, so the chip
 * states the move rather than the outcome. Returns null when no credit change is
 * threaded or the catalog can't word the to-side. Display-only.
 */
export function useResizeCreditsChange(
  change: CreditTierChange | null | undefined,
): CreditsChange | null {
  const proPlan = useProPlan(change != null);

  if (change == null) {
    return null;
  }
  const toLabel = creditTierLabel(proPlan, change.toTier);
  if (toLabel === undefined) {
    return null;
  }
  return { fromLabel: creditTierLabel(proPlan, change.fromTier), toLabel };
}
