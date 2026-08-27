import type { QueryClient } from "@tanstack/react-query";

import {
  organizationsBillingPlansRetrieveQueryKey,
  organizationsBillingSubscriptionOnboardingRetrieveQueryKey,
  organizationsBillingSubscriptionRetrieveQueryKey,
  organizationsBillingSummaryRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";

/**
 * Invalidates every billing query a plan change can stale: the subscription,
 * the plan catalog, the onboarding ceiling, and the billing summary whose
 * usage-grant figures draw the Usage Balance bar. Shared by every path that
 * changes the subscription (immediate package and tier changes, and the
 * native checkout-sheet dismissal), so a billing read added here refreshes on
 * all of them at once instead of drifting per call site.
 *
 * Await the returned promise when the caller must read the refetched data
 * next (the resize takeover reads the onboarding ceiling); `void` it when the
 * surrounding UI simply re-renders as the refetches land.
 */
export function invalidateBillingQueries(
  queryClient: QueryClient,
): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({
      queryKey: organizationsBillingSubscriptionRetrieveQueryKey(),
    }),
    queryClient.invalidateQueries({
      queryKey: organizationsBillingPlansRetrieveQueryKey(),
    }),
    queryClient.invalidateQueries({
      queryKey: organizationsBillingSubscriptionOnboardingRetrieveQueryKey(),
    }),
    queryClient.invalidateQueries({
      queryKey: organizationsBillingSummaryRetrieveQueryKey(),
    }),
  ]);
}
