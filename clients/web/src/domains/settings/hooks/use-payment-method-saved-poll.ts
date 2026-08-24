import { useMutation, useQueryClient } from "@tanstack/react-query";

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
 * saved card until the webhook lands. The poll then reads the endpoint
 * OUTSIDE the query cache, because a cache-writing refetch would clobber
 * that flip with a pre-webhook "no card" response. Only a response whose
 * `stripe_payment_method_updated_at` advanced past its pre-save value is
 * written back, filling in brand/last4. If the webhook still hasn't landed
 * at the timeout, the flipped config stays put and the query's normal
 * refetches (focus, remount) reconcile with the server. Always resolves.
 */
export function usePaymentMethodSavedPoll(): () => Promise<void> {
  const queryClient = useQueryClient();

  return async () => {
    const prior = queryClient.getQueryData<AutoTopUpConfigResponse>(
      organizationsBillingAutoTopUpRetrieveQueryKey(),
    );
    const priorMarker = prior?.stripe_payment_method_updated_at ?? null;

    if (prior != null && !prior.has_payment_method) {
      organizationsBillingAutoTopUpRetrieveSetQueryData(
        queryClient,
        undefined,
        { ...prior, has_payment_method: true },
      );
    }

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
