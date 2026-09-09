import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  organizationsBillingDailyCreditLimitRetrieveQueryKey,
  organizationsBillingDailyCreditLimitRetrieveSetQueryData,
  organizationsBillingDailyCreditLimitUpdateMutation,
  organizationsBillingSummaryRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";

/**
 * Save or clear the org's daily credit limit and keep every reader current.
 * The PUT response seeds the daily-limit query so the settings card shows
 * the new limit on its next render, then that query and the billing summary
 * refetch: the summary carries the derived `daily_limit_reached` and
 * `daily_credit_limit_usd` fields the chat banner and the card's spend
 * readout depend on. Shared by `DailyCreditLimitCard` and the auto-reload
 * daily-limit gate so both land the same cache state.
 */
export function useDailyCreditLimitUpdate() {
  const queryClient = useQueryClient();
  return useMutation({
    ...organizationsBillingDailyCreditLimitUpdateMutation(),
    onSuccess: (data) => {
      organizationsBillingDailyCreditLimitRetrieveSetQueryData(
        queryClient,
        undefined,
        data,
      );
      void queryClient.invalidateQueries({
        queryKey: organizationsBillingDailyCreditLimitRetrieveQueryKey(),
      });
      void queryClient.invalidateQueries({
        queryKey: organizationsBillingSummaryRetrieveQueryKey(),
      });
    },
  });
}
