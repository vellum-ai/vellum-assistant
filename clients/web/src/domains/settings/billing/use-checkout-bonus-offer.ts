import { useQuery } from "@tanstack/react-query";

import { organizationsBillingCheckoutBonusRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";

export interface CheckoutBonusOffer {
  /** True once the server has verified the offer is claimable. */
  showOffer: boolean;
  /**
   * Offer amount as a USD decimal string (e.g. "5.00") from the eligibility
   * response. Meaningful only while `showOffer` is true.
   */
  amountUsd: string;
}

/**
 * Server-verified eligibility for the abandoned-checkout credit bonus.
 *
 * `triggered` is the client-side cancel signal (`?billing_status=cancel`,
 * which the Pro upgrade-cancel page also funnels into). The GET is the
 * authority on eligibility (the client never decides it), so a hand-typed
 * cancel URL with no real abandoned checkout behind it resolves to
 * `eligible: false` and shows nothing.
 *
 * Gated on org readiness exactly like the other billing queries: a request
 * fired before the org store settles omits `Vellum-Organization-Id` and the
 * platform rejects it.
 */
export function useCheckoutBonusOffer(triggered: boolean): CheckoutBonusOffer {
  const orgReady = useIsOrgReady();
  const { data } = useQuery({
    ...organizationsBillingCheckoutBonusRetrieveOptions(),
    enabled: triggered && orgReady,
  });
  return {
    showOffer: triggered && data?.eligible === true,
    amountUsd: data?.amount_usd ?? "0.00",
  };
}
