import { hashKey, useMutation, useQueryClient } from "@tanstack/react-query";

import {
  organizationsBillingAutoTopUpConfirmSetupIntentCreateMutation,
  organizationsBillingAutoTopUpRetrieveQueryKey,
  organizationsBillingAutoTopUpRetrieveSetQueryData,
} from "@/generated/api/@tanstack/react-query.gen";
import { organizationsBillingAutoTopUpRetrieve } from "@/generated/api/sdk.gen";
import type { AutoTopUpConfigResponse } from "@/generated/api/types.gen";

export const PM_SAVED_POLL_INTERVAL_MS = 1500;
export const PM_SAVED_MAX_POLL_MS = 20_000;

/**
 * Returns the follow-up for `AutoTopUpPaymentMethodModal`'s
 * `onSavedOptimistic`: the `setup_intent.succeeded` webhook persists
 * `stripe_payment_method_id` asynchronously, so the config GET can keep
 * answering "no card" for a while after Stripe has confirmed the save.
 *
 * Stripe already confirmed the SetupIntent by the time this runs, so the
 * cached config is flipped to `has_payment_method: true` up front; the
 * Payment Methods card would otherwise keep offering Add instead of the
 * saved card until the webhook lands. Three guards keep that flip on screen
 * for the poll's whole window:
 *
 * - in-flight cache-writing fetches are cancelled before the flip, so a
 *   request started pre-save can't land a stale response after it;
 * - the poll reads the endpoint OUTSIDE the query cache and writes back
 *   only a response whose `stripe_payment_method_updated_at` advanced past
 *   its pre-save value (filling in brand/last4);
 * - a cache subscription re-asserts the flip immediately if an observer
 *   refetch (window focus, reconnect) writes a pre-webhook "no card"
 *   response over it while the poll is live.
 *
 * If the webhook still hasn't landed at the timeout, the flipped config
 * stays put and the query's normal refetches reconcile with the server.
 * Always resolves.
 */
export function usePaymentMethodSavedPoll(): () => Promise<void> {
  const queryClient = useQueryClient();

  return async () => {
    const queryKey = organizationsBillingAutoTopUpRetrieveQueryKey();
    const prior = queryClient.getQueryData<AutoTopUpConfigResponse>(queryKey);
    const priorMarker = prior?.stripe_payment_method_updated_at ?? null;

    await queryClient.cancelQueries({ queryKey });

    const flipToSaved = () => {
      const current =
        queryClient.getQueryData<AutoTopUpConfigResponse>(queryKey);
      if (current != null && !current.has_payment_method) {
        organizationsBillingAutoTopUpRetrieveSetQueryData(
          queryClient,
          undefined,
          { ...current, has_payment_method: true },
        );
      }
    };
    flipToSaved();

    // Re-entrancy terminates: the flip makes the event it triggers a no-op.
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (
        event.type === "updated" &&
        event.query.queryHash === hashKey(queryKey)
      ) {
        flipToSaved();
      }
    });

    try {
      const start = Date.now();
      while (Date.now() - start < PM_SAVED_MAX_POLL_MS) {
        try {
          const { data: refetched } =
            await organizationsBillingAutoTopUpRetrieve();
          if (
            refetched != null &&
            refetched.has_payment_method &&
            refetched.stripe_payment_method_updated_at !== priorMarker
          ) {
            organizationsBillingAutoTopUpRetrieveSetQueryData(
              queryClient,
              undefined,
              refetched,
            );
            return;
          }
        } catch {
          // sleep and retry
        }
        await new Promise((resolve) =>
          setTimeout(resolve, PM_SAVED_POLL_INTERVAL_MS),
        );
      }
    } finally {
      unsubscribe();
    }
  };
}

/**
 * Confirm-first version of the follow-up above. The confirm endpoint persists
 * the card and returns the same payload as the config GET, with brand and
 * last4 filled in, so seeding the cache from it makes the saved card visible
 * without waiting on the `setup_intent.succeeded` webhook. In-flight fetches
 * are cancelled before seeding so a pre-confirm response can't land over it;
 * any refetch after the confirm resolves reads the persisted card.
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
        await queryClient.cancelQueries({
          queryKey: organizationsBillingAutoTopUpRetrieveQueryKey(),
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
