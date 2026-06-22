import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CreditCard, Loader2, Trash2 } from "lucide-react";
import { useState } from "react";

import {
    organizationsBillingAutoTopUpRemovePaymentMethodCreateMutation,
    organizationsBillingAutoTopUpRetrieveOptions,
    organizationsBillingAutoTopUpRetrieveQueryKey,
    organizationsBillingAutoTopUpRetrieveSetQueryData,
} from "@/generated/api/@tanstack/react-query.gen";
import type { AutoTopUpConfigResponse } from "@/generated/api/types.gen";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { Notice } from "@vellumai/design-library/components/notice";
import { toast } from "@vellumai/design-library/components/toast";
import { Typography } from "@vellumai/design-library/components/typography";

import { DISABLED_CONFIG } from "@/domains/settings/components/auto-top-up-card";
import { AutoTopUpPaymentMethodModal } from "@/domains/settings/components/auto-top-up-payment-method-modal";
import { brandLabel } from "@/domains/settings/utils/payment-method-brand";

// ---------------------------------------------------------------------------
// PaymentMethodsCard — manages exactly the auto-top-up payment method.
// ---------------------------------------------------------------------------

function PaymentMethodHeading() {
  return (
    <div>
      <Typography
        as="h2"
        variant="title-medium"
        className="text-[var(--content-default)]"
      >
        Payment Method
      </Typography>
      <Typography
        as="p"
        variant="body-small-default"
        className="mt-2 text-[var(--content-tertiary)]"
      >
        This is the payment method that will be used for automated credit reloads.
      </Typography>
    </div>
  );
}

export function PaymentMethodsCard() {
  const queryClient = useQueryClient();
  const configQuery = useQuery(organizationsBillingAutoTopUpRetrieveOptions());

  const [pmModalOpen, setPmModalOpen] = useState(false);
  const [confirmRemovePm, setConfirmRemovePm] = useState(false);

  const removePmMutation = useMutation(
    organizationsBillingAutoTopUpRemovePaymentMethodCreateMutation(),
  );

  const handlePmSavedOptimistic = async () => {
    // The `setup_intent.succeeded` webhook persists `stripe_payment_method_id`
    // asynchronously, so a single invalidate+refetch can race the webhook and
    // leave the cache stale — locking the AutoTopUpCard toggle (Add flow) or
    // showing the wrong brand/last4 (Change flow) until the user reloads.
    // Snapshot the prior PM-save timestamp and poll until it actually
    // changes, with a timeout so we never spin forever if the webhook never
    // lands.
    //
    // `has_payment_method` alone is insufficient as the completion signal:
    // in the Change flow it's already `true` before the webhook lands, so a
    // first refetch reads pre-webhook data and exits immediately. A
    // (has, brand, last4) fingerprint is also insufficient: if the user
    // replaces the card with another that has the same brand+last4 (or
    // re-saves the same card), the fingerprint never changes and the modal
    // waits the full timeout even though setup already succeeded.
    //
    // `stripe_payment_method_updated_at` is set to the webhook's
    // `event_created_at` on every successful save (see
    // `app/billing/webhook_views.py` setup_intent.succeeded handler), so the
    // timestamp is uniquely advanced per save and is a reliable transition
    // marker for both Add and Change (including same-card replace).
    //
    // Errors from invalidate/fetchQuery (transient network hiccup, 5xx,
    // timeout) must NOT bubble to the caller: AutoTopUpPaymentMethodModal
    // awaits this before `onClose()`, so a single rejected refetch would
    // trap the user in the modal even though Stripe setup succeeded. Treat
    // any error as "not yet fresh, keep polling" until the timeout.
    const POLL_INTERVAL_MS = 1500;
    const MAX_POLL_MS = 20_000;
    const start = Date.now();
    const transitionMarker = (config: AutoTopUpConfigResponse | undefined) =>
      config?.stripe_payment_method_updated_at ?? null;
    const priorMarker = transitionMarker(
      queryClient.getQueryData<AutoTopUpConfigResponse>(
        organizationsBillingAutoTopUpRetrieveQueryKey(),
      ),
    );
    try {
      await queryClient.invalidateQueries({
        queryKey: organizationsBillingAutoTopUpRetrieveQueryKey(),
      });
    } catch {
      // swallow — fall through to fetchQuery polling
    }
    while (Date.now() - start < MAX_POLL_MS) {
      try {
        const refetched = await queryClient.fetchQuery(
          organizationsBillingAutoTopUpRetrieveOptions(),
        );
        if (
          refetched.has_payment_method &&
          transitionMarker(refetched) !== priorMarker
        ) {
          return;
        }
      } catch {
        // swallow — sleep and retry
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    // Timed out — leave the cache as-is. The user can reload to recover.
  };

  if (configQuery.isLoading) {
    return (
      <Card padding="md">
        <PaymentMethodHeading />
        <div className="mt-4 flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading…
        </div>
      </Card>
    );
  }

  if (configQuery.isError || !configQuery.data) {
    return (
      <Card padding="md">
        <PaymentMethodHeading />
        <div className="mt-4">
          <Notice tone="error">Failed to load payment method.</Notice>
        </div>
      </Card>
    );
  }

  const config = configQuery.data;
  const brand = brandLabel(config.payment_method_brand ?? "card");
  const last4 = config.payment_method_last4;

  return (
    <>
      <Card padding="md">
        <div className="flex flex-col gap-4">
          <PaymentMethodHeading />
          {!config.has_payment_method ? (
            <Button className="self-start" onClick={() => setPmModalOpen(true)}>
              Add Card
            </Button>
          ) : (
            <div className="flex items-center gap-3 rounded-lg bg-[var(--surface-base)] px-2 py-1.5">
              <span
                aria-hidden
                className="flex h-6 w-6 shrink-0 items-center justify-center text-[var(--content-emphasised)]"
              >
                <CreditCard className="h-3.5 w-3.5" />
              </span>
              <div className="min-w-0 flex-1">
                <Typography variant="body-medium-default" as="span">
                  {brand}
                </Typography>
                {last4 ? (
                  <Typography variant="body-small-default" as="div" className="text-[var(--content-tertiary)]">
                    Ending in {last4}
                  </Typography>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  onClick={() => setPmModalOpen(true)}
                >
                  Change
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setConfirmRemovePm(true)}
                  disabled={confirmRemovePm || removePmMutation.isPending}
                  leftIcon={<Trash2 className="h-3.5 w-3.5" />}
                >
                  Remove
                </Button>
              </div>
            </div>
          )}
        </div>
      </Card>

      <ConfirmDialog
        open={confirmRemovePm}
        title="Remove payment method?"
        message="Removing your payment method will disable automatic top-ups. You can re-enable them after adding a new payment method."
        confirmLabel={removePmMutation.isPending ? "Removing…" : "Remove"}
        cancelLabel="Keep"
        destructive
        onConfirm={() => {
          if (removePmMutation.isPending) return;
          removePmMutation.mutate(
            {},
            {
              onSuccess: () => {
                // The remove endpoint clears `stripe_payment_method_id` and
                // flips `enabled=False` but intentionally preserves the
                // saved thresholds (`threshold_usd`, `amount_usd`,
                // `monthly_cap_usd`) so the user can re-enable later
                // without re-entering them. Merge from the prior cache so
                // the AutoTopUpCard sibling (same query key) doesn't render
                // an empty config until the next refetch lands.
                organizationsBillingAutoTopUpRetrieveSetQueryData(
                  queryClient,
                  undefined,
                  (prior) =>
                    prior
                      ? {
                          ...prior,
                          enabled: false,
                          has_payment_method: false,
                          payment_method_brand: null,
                          payment_method_last4: null,
                        }
                      : DISABLED_CONFIG,
                );
                setConfirmRemovePm(false);
              },
              onError: () => {
                toast.error(
                  "Failed to remove payment method. Please try again.",
                );
                setConfirmRemovePm(false);
              },
            },
          );
        }}
        onCancel={() => {
          if (!removePmMutation.isPending) setConfirmRemovePm(false);
        }}
      />

      <AutoTopUpPaymentMethodModal
        open={pmModalOpen}
        onClose={() => setPmModalOpen(false)}
        onSavedOptimistic={handlePmSavedOptimistic}
      />
    </>
  );
}
