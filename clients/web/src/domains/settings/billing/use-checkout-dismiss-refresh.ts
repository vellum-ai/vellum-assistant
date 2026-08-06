import { useEffect } from "react";

import { useQueryClient } from "@tanstack/react-query";

import {
  organizationsBillingPlansRetrieveQueryKey,
  organizationsBillingSubscriptionOnboardingRetrieveQueryKey,
  organizationsBillingSubscriptionRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import { openUrlFinishedListener } from "@/runtime/browser";

/**
 * Refetches the billing queries when a Capacitor `SFSafariViewController`
 * checkout sheet is dismissed.
 *
 * On native iOS `openUrl` keeps Stripe Checkout inside an in-app browser
 * sheet, so the success URL loads in that sheet and the surrounding WKWebView
 * never navigates — it holds pre-checkout subscription data until something
 * invalidates it. `browserFinished` (dismiss or complete) is the only signal
 * the app gets. Mirrors the listener `adjust-plan-modal` already installs, for
 * the checkout entry points that render outside it.
 *
 * No-ops off native.
 */
export function useCheckoutDismissRefresh(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    return openUrlFinishedListener(() => {
      void queryClient.invalidateQueries({
        queryKey: organizationsBillingSubscriptionRetrieveQueryKey(),
      });
      void queryClient.invalidateQueries({
        queryKey: organizationsBillingPlansRetrieveQueryKey(),
      });
      void queryClient.invalidateQueries({
        queryKey: organizationsBillingSubscriptionOnboardingRetrieveQueryKey(),
      });
    });
  }, [queryClient]);
}
