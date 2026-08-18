import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  organizationsBillingDailyCreditLimitRetrieveQueryKey,
  organizationsBillingDailyCreditLimitSkipTodayCreateMutation,
  organizationsBillingDailyCreditLimitSkipTodayDestroyMutation,
  organizationsBillingSummaryRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";

/**
 * Invalidate everything a skip changes. The daily-credit-limit query owns the
 * skip state the settings card renders; the billing summary owns
 * `daily_limit_reached`, which is what makes the composer banner appear and
 * disappear. Skipping without refreshing the summary would leave the banner on
 * screen over a limit that is no longer enforced.
 */
function useInvalidateAfterSkipChange(): () => void {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({
      queryKey: organizationsBillingDailyCreditLimitRetrieveQueryKey(),
    });
    void queryClient.invalidateQueries({
      queryKey: organizationsBillingSummaryRetrieveQueryKey(),
    });
  };
}

/**
 * Skip the org's daily credit limit for the rest of the current UTC day.
 *
 * The limit itself is left untouched. Only its enforcement pauses, and it
 * resumes on its own at the next reset. Shared by the composer's daily-limit
 * banner and the billing settings card so both refresh the same queries.
 */
export function useSkipDailyLimitToday() {
  const invalidate = useInvalidateAfterSkipChange();
  return useMutation({
    ...organizationsBillingDailyCreditLimitSkipTodayCreateMutation(),
    onSuccess: invalidate,
  });
}

/** End an active skip early, restoring enforcement immediately. */
export function useResumeDailyLimit() {
  const invalidate = useInvalidateAfterSkipChange();
  return useMutation({
    ...organizationsBillingDailyCreditLimitSkipTodayDestroyMutation(),
    onSuccess: invalidate,
  });
}
