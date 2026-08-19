import { useQueryClient } from "@tanstack/react-query";

import {
  organizationsBillingAutoTopUpRetrieveOptions,
  organizationsBillingAutoTopUpRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import type { AutoTopUpConfigResponse } from "@/generated/api/types.gen";

export const PM_SAVED_POLL_INTERVAL_MS = 1500;
export const PM_SAVED_MAX_POLL_MS = 20_000;

/**
 * Returns the follow-up for `AutoTopUpPaymentMethodModal`'s
 * `onSavedOptimistic`: the `setup_intent.succeeded` webhook persists
 * `stripe_payment_method_id` asynchronously, so a single invalidate+refetch
 * can race the webhook and leave the cache stale. Poll until
 * `stripe_payment_method_updated_at` actually advances past its pre-save
 * value, with a timeout so this never spins forever if the webhook never
 * lands. Always resolves.
 */
export function usePaymentMethodSavedPoll(): () => Promise<void> {
  const queryClient = useQueryClient();

  return async () => {
    // Snapshot the marker before invalidating so the comparison below is
    // against the pre-save value.
    const priorMarker =
      queryClient.getQueryData<AutoTopUpConfigResponse>(
        organizationsBillingAutoTopUpRetrieveQueryKey(),
      )?.stripe_payment_method_updated_at ?? null;
    const start = Date.now();

    try {
      await queryClient.invalidateQueries({
        queryKey: organizationsBillingAutoTopUpRetrieveQueryKey(),
      });
    } catch {
      // fall through to polling below
    }

    while (Date.now() - start < PM_SAVED_MAX_POLL_MS) {
      try {
        const refetched = await queryClient.fetchQuery(
          organizationsBillingAutoTopUpRetrieveOptions(),
        );
        if (
          refetched.has_payment_method &&
          refetched.stripe_payment_method_updated_at !== priorMarker
        ) {
          break;
        }
      } catch {
        // sleep and retry
      }
      await new Promise((resolve) =>
        setTimeout(resolve, PM_SAVED_POLL_INTERVAL_MS),
      );
    }
  };
}
