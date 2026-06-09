import {
    AddressElement,
    Elements,
    PaymentElement,
    useElements,
    useStripe,
} from "@stripe/react-stripe-js";
import { loadStripe, type Appearance, type Stripe } from "@stripe/stripe-js";
import { useMutation } from "@tanstack/react-query";
import { AlertCircle, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { organizationsBillingAutoTopUpSetupIntentCreateMutation } from "@/generated/api/@tanstack/react-query.gen";
import { Button } from "@vellumai/design-library/components/button";
import { Modal } from "@vellumai/design-library/components/modal";
import { Notice } from "@vellumai/design-library/components/notice";
import { toast } from "@vellumai/design-library/components/toast";

// Stripe publishable key — injected at build time by the deployment pipeline.
// This is Stripe's *publishable* key (pk_live_* / pk_test_*), designed to be
// embedded in client bundles: https://docs.stripe.com/keys#obtain-api-keys
// Not in .env.example because local/OSS contributors don't need billing;
// without it the modal gracefully shows <MissingStripeKeyNotice />.
const STRIPE_PK = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY ?? "";

let stripePromise: Promise<Stripe | null> | null = null;
function getStripePromise() {
  if (!stripePromise && STRIPE_PK) {
    stripePromise = loadStripe(STRIPE_PK);
  }
  return stripePromise;
}

function getStripeAppearance(): Appearance {
  const isDark =
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark");
  return isDark ? { theme: "night" } : { theme: "stripe" };
}

export interface AutoTopUpPaymentMethodModalProps {
  open: boolean;
  onClose: () => void;
  /**
   * Called after `confirmSetup` succeeds. Owners use this to invalidate the
   * auto-top-up config query so the saved-PM line and `has_payment_method`
   * gate reflect the new card immediately.
   *
   * May return a Promise; the modal awaits it before calling `onClose()` so
   * the parent re-renders against fresh data instead of briefly showing
   * stale payment-method copy after a successful save.
   */
  onSavedOptimistic: () => void | Promise<void>;
}

/**
 * Modal that bootstraps a Stripe SetupIntent (via the heyapi mutation) and
 * mounts `<PaymentElement />` plus a billing-mode `<AddressElement />`
 * inside `<Elements>` so the user can save a card — with a billing address
 * for tax — on the org's Stripe customer to use for auto-top-up off-session
 * charges. The card is tagged via SetupIntent metadata so the webhook can
 * persist it onto AutoTopUpConfig. There is no separate auto-top-up Stripe
 * customer — auto-top-up uses the org's single Stripe customer (the same
 * one PaymentMethodViewSet uses).
 *
 * Flow:
 *  1. Modal opens → fire `organizationsBillingAutoTopUpSetupIntentCreate`
 *     to fetch a `client_secret`.
 *  2. While pending, render a centered spinner.
 *  3. On error, render a `Notice tone="error"` with a "Try again" button
 *     that re-runs the mutation.
 *  4. On success, mount `<SetupCardForm />` inside `<Elements>` and let the
 *     user submit. `confirmSetup({redirect: "if_required"})` resolves
 *     in-page when the PM doesn't need 3DS, and otherwise redirects to
 *     `window.location.href` (so the user lands back on the current
 *     settings page).
 *  5. On success, toast + `onSavedOptimistic()` + `onClose()`.
 */
export function AutoTopUpPaymentMethodModal({
  open,
  onClose,
  onSavedOptimistic,
}: AutoTopUpPaymentMethodModalProps) {
  const setupIntentMutation = useMutation(
    organizationsBillingAutoTopUpSetupIntentCreateMutation(),
  );
  // `mutate` / `reset` are stable across renders in TanStack Query 5; binding
  // to them (instead of the whole mutation object) keeps the effect deps
  // honest without re-firing on every render.
  const { mutate: createSetupIntent, reset: resetSetupIntent } =
    setupIntentMutation;

  // Fire the SetupIntent fetch once each time the modal opens; reset on close
  // so a stale `client_secret` or error doesn't leak into the next open.
  // Skip the mutation entirely when `STRIPE_PK` is empty — without it the
  // modal can only render `<MissingStripeKeyNotice />`, so creating a
  // SetupIntent (and bootstrapping a Stripe Customer for the org if missing)
  // would just spawn orphan SetupIntents the user can never complete.
  useEffect(() => {
    if (open) {
      if (!STRIPE_PK) return;
      createSetupIntent({});
    } else {
      resetSetupIntent();
    }
  }, [open, createSetupIntent, resetSetupIntent]);

  const clientSecret = setupIntentMutation.data?.client_secret ?? null;

  // Resolve Stripe appearance once per modal open (keyed on clientSecret) so
  // Elements picks up the active light/dark theme without a stale cache.
  const stripeAppearance = useMemo(() => getStripeAppearance(), [clientSecret]);

  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Modal.Content size="sm">
        <Modal.Header>
          <Modal.Title>Save Payment Method</Modal.Title>
        </Modal.Header>
        <Modal.Body className="min-h-[260px]">
          {!STRIPE_PK ? (
            // Short-circuit: when the publishable key is missing the
            // mutation is also skipped (see `useEffect` above), so the
            // pending-or-no-client-secret branch below would otherwise
            // render a perpetual spinner. Render the notice directly.
            <MissingStripeKeyNotice />
          ) : setupIntentMutation.isPending || (!clientSecret && !setupIntentMutation.isError) ? (
            <div
              className="flex min-h-[260px] items-center justify-center"
              data-testid="auto-top-up-pm-modal-spinner"
            >
              <Loader2 className="h-6 w-6 animate-spin text-[var(--content-tertiary)]" />
            </div>
          ) : setupIntentMutation.isError ? (
            <div className="space-y-3" data-testid="auto-top-up-pm-modal-error">
              <Notice tone="error">
                Failed to start card setup. Please try again.
              </Notice>
              <div className="flex justify-end">
                <Button
                  variant="primary"
                  onClick={() => createSetupIntent({})}
                >
                  Try again
                </Button>
              </div>
            </div>
          ) : clientSecret && STRIPE_PK ? (
            <Elements
              stripe={getStripePromise()}
              options={{
                clientSecret,
                appearance: stripeAppearance,
              }}
            >
              <SetupCardForm
                onSuccess={async () => {
                  toast.success("Payment method saved.");
                  // Await the parent's optimistic refetch before closing so
                  // the next render reads fresh auto-top-up data. Without
                  // the await, `onClose()` fires immediately and the user
                  // briefly sees stale PM copy.
                  await onSavedOptimistic();
                  onClose();
                }}
                onCancel={onClose}
              />
            </Elements>
          ) : (
            <MissingStripeKeyNotice />
          )}
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
}

// Fallback when VITE_STRIPE_PUBLISHABLE_KEY is not set at build time.

function MissingStripeKeyNotice() {
  useEffect(() => {
    console.warn(
      "[AutoTopUpPaymentMethodModal] VITE_STRIPE_PUBLISHABLE_KEY is not set; the payment-method modal cannot mount Stripe Elements.",
    );
  }, []);
  return (
    <Notice tone="error">
      Payment method setup is currently unavailable. Please try again later.
    </Notice>
  );
}

// ---------------------------------------------------------------------------
// SetupCardForm — rendered inside the `<Elements>` provider above so it can
// call `useStripe` / `useElements`. Submits via `confirmSetup` and bubbles
// success/cancel back to the modal.
// ---------------------------------------------------------------------------

function SetupCardForm({
  onSuccess,
  onCancel,
}: {
  onSuccess: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elementReady, setElementReady] = useState(false);
  const [addressElementReady, setAddressElementReady] = useState(false);
  const ready = elementReady && addressElementReady;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements || !ready) return;

    setSubmitting(true);
    setError(null);

    try {
      const result = await stripe.confirmSetup({
        elements,
        confirmParams: {
          return_url: window.location.href,
        },
        redirect: "if_required",
      });

      if (result.error) {
        setError(result.error.message ?? "Failed to save payment method.");
        return;
      }
      // Await `onSuccess` so the parent's cache invalidation completes
      // before the modal unmounts. The `finally` below resets submitting
      // even if `onSuccess` throws — keeping the spinner visible while
      // invalidation is in flight is intentional.
      await onSuccess();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6 pt-4">
      <PaymentElement
        onReady={() => setElementReady(true)}
        onLoadError={() =>
          setError(
            "Failed to load the payment form. Please close and reopen this dialog.",
          )
        }
        options={{
          layout: { type: "tabs", defaultCollapsed: false },
          paymentMethodOrder: ["card", "us_bank_account"],
          // The Address Element below owns the billing address (so the saved
          // PM carries billing_details.address for tax) and unconditionally
          // collects a name; suppress the Payment Element's own name and
          // address inputs to avoid duplicate "Full name" (us_bank_account)
          // and postal-code fields. Email stays with the Payment Element —
          // the Address Element doesn't collect it.
          fields: { billingDetails: { name: "never", address: "never" } },
        }}
      />
      {/*
        Billing address for tax: mounted in the same <Elements> group, the
        Address Element's value is attached to the PaymentMethod's
        billing_details automatically by `stripe.confirmSetup({ elements })` —
        no manual plumbing. The Django webhook seeds `customer.address` from
        it.
      */}
      <AddressElement
        onReady={() => setAddressElementReady(true)}
        onLoadError={() =>
          setError(
            "Failed to load the billing address form. Please close and reopen this dialog.",
          )
        }
        options={{
          mode: "billing",
          fields: { phone: "never" },
        }}
      />
      {error && (
        <div
          className="flex items-center gap-2 text-body-small-default text-[var(--system-negative-strong)]"
          data-testid="auto-top-up-pm-modal-confirm-error"
        >
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          {error}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          type="button"
          onClick={onCancel}
          disabled={submitting}
        >
          Cancel
        </Button>
        <Button
          variant="primary"
          type="submit"
          data-testid="auto-top-up-pm-save-button"
          disabled={submitting || !stripe || !elements || !ready}
          leftIcon={submitting ? <Loader2 className="animate-spin" /> : undefined}
        >
          Save
        </Button>
      </div>
    </form>
  );
}
