import { useEffect, useRef } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { organizationsBillingCheckoutBonusRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";

export interface CheckoutBonusOffer {
  /**
   * True once the server has verified, for the most recent cancel trigger,
   * that the offer is claimable.
   */
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
 * `cancelledAt` is the client-side cancel signal: the `Date.now()` of the most
 * recent definitive cancel (`?billing_status=cancel`, which the upgrade-cancel
 * page and the native `flow=top_up&status=cancel` deep link also funnel into),
 * or `null` before any cancel. A timestamp rather than a boolean so repeat
 * cancels on a persistent SPA mount (Electron/iOS never reload the document)
 * each read as a fresh trigger instead of latching after the first. The GET is
 * the authority on eligibility (the client never decides it), so a hand-typed
 * cancel URL with no real abandoned checkout behind it resolves to
 * `eligible: false` and shows nothing.
 *
 * Gated on org readiness exactly like the other billing queries: a request
 * fired before the org store settles omits `Vellum-Organization-Id` and the
 * platform rejects it.
 *
 * Every trigger asks the server again, at a cost of exactly one request:
 * - The first trigger flips `enabled`, and `staleTime: 0` (overriding the app
 *   QueryClient's 10s default) makes that transition fetch even when a recent
 *   probe (an upgrade cancel, a hand-typed URL) left an `eligible: false`
 *   answer in the cache.
 * - A repeat trigger never toggles `enabled`, so the effect below invalidates
 *   the query instead. The first arming is excluded there because the enabled
 *   transition already fetches, and focus refetches are disabled.
 *
 * `showOffer` additionally requires the answer to postdate the trigger
 * (`dataUpdatedAt >= cancelledAt`), so a stale `eligible: true` from an
 * earlier cancel cannot re-open the offer in the window before the fresh
 * verification lands.
 */
export function useCheckoutBonusOffer(
  cancelledAt: number | null,
): CheckoutBonusOffer {
  const orgReady = useIsOrgReady();
  const queryClient = useQueryClient();
  const triggered = cancelledAt !== null;
  const { data, dataUpdatedAt } = useQuery({
    ...organizationsBillingCheckoutBonusRetrieveOptions(),
    enabled: triggered && orgReady,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });

  const armedAtRef = useRef(cancelledAt);
  useEffect(() => {
    const previous = armedAtRef.current;
    armedAtRef.current = cancelledAt;
    if (cancelledAt === null || cancelledAt === previous || previous === null) {
      return;
    }
    // Refetches when the query is enabled; while it's still org-gated this
    // only marks the cache stale and the enabled transition fetches later.
    void queryClient.invalidateQueries(
      organizationsBillingCheckoutBonusRetrieveOptions(),
    );
  }, [cancelledAt, queryClient]);

  return {
    showOffer:
      triggered && data?.eligible === true && dataUpdatedAt >= cancelledAt,
    amountUsd: data?.amount_usd ?? "0.00",
  };
}
