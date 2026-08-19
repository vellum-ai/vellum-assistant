import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  organizationsBillingAutoTopUpConfirmSetupIntentCreateMutation,
  organizationsBillingAutoTopUpRetrieveOptions,
  organizationsBillingAutoTopUpRetrieveQueryKey,
  organizationsBillingAutoTopUpRetrieveSetQueryData,
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

/**
 * Confirm-first version of the follow-up above. The confirm endpoint persists
 * the card and returns the same payload as the config GET, with brand and
 * last4 filled in, so seeding the cache from it makes the saved card visible
 * without waiting on the `setup_intent.succeeded` webhook.
 *
 * The poll stays as the fallback: when the confirm call fails for any reason
 * (the endpoint is unavailable on this server, or the request errors), the
 * webhook remains the durable writer and the poll waits for its write.
 */
export function usePaymentMethodSavedSync(): (args: {
  setupIntentId: string | null;
}) => Promise<void> {
  const queryClient = useQueryClient();
  const pollPaymentMethodSaved = usePaymentMethodSavedPoll();
  const { mutateAsync: confirmSetupIntent } = useMutation(
    organizationsBillingAutoTopUpConfirmSetupIntentCreateMutation(),
  );

  return async ({ setupIntentId }) => {
    if (setupIntentId != null) {
      try {
        const config = await confirmSetupIntent({
          body: { setup_intent_id: setupIntentId },
        });
        organizationsBillingAutoTopUpRetrieveSetQueryData(
          queryClient,
          undefined,
          config,
        );
        return;
      } catch {
        // fall through to the poll below
      }
    }
    await pollPaymentMethodSaved();
  };
}
