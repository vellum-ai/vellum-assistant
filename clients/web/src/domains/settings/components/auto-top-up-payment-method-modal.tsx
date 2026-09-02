import {
  AddressElement,
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import type { SetupIntentResult } from "@stripe/stripe-js";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  buildStripeAppearance,
  STRIPE_FONTS,
} from "@/domains/settings/billing/stripe-appearance";
import {
  getStripePromise,
  setupIntentIdFromClientSecret,
  STRIPE_PK,
} from "@/domains/settings/billing/stripe-client";
import {
  FieldSkeletons,
  FIELD_STACK_CLASS,
} from "@/domains/settings/components/field-skeletons";
import {
  PaymentMethodModalShell,
  type CardOnFile,
  type PaymentMethodModalMode,
  type PaymentMethodModalState,
} from "@/domains/settings/components/payment-method-modal-shell";
import type { SavedPaymentMethod } from "@/domains/settings/hooks/use-payment-method-saved-poll";
import { organizationsBillingAutoTopUpSetupIntentCreateMutation } from "@/generated/api/@tanstack/react-query.gen";
import type { BillingAddress } from "@/generated/api/types.gen";
import { useDocumentTheme } from "@/hooks/use-document-theme";
import { useTranslation } from "@/i18n";
import { useAndroidBillingHandoff } from "@/lib/billing/android-billing-handoff";
import { useAuthStore } from "@/stores/auth-store";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library/components/button";
import { Notice } from "@vellumai/design-library/components/notice";
import { cn } from "@vellumai/design-library/utils/cn";

/**
 * Our own terms sentence waits on legal sign-off; while this is false Stripe's
 * mandate renders inside the Payment Element instead.
 */
export const CUSTOM_TERMS_APPROVED = false;

/**
 * Stripe.js emits no event when an in-page 3DS challenge opens, so a confirm
 * still pending after this long is treated as waiting on the bank.
 */
export const REQUIRES_ACTION_HINT_MS = 1500;

/** How long the success panel stays on screen before the modal closes itself. */
export const SAVED_AUTO_CLOSE_MS = 900;

/** The result of a 3DS redirect return, replayed into a freshly opened modal. */
export type SetupIntentOutcome =
  | { kind: "saved"; card: SavedPaymentMethod | null }
  | { kind: "error"; message: string };

export interface AutoTopUpPaymentMethodModalProps {
  open: boolean;
  onClose: () => void;
  mode?: PaymentMethodModalMode;
  /** The card being replaced; named in the subtitle only in `replace` mode. */
  cardOnFile?: CardOnFile | null;
  /** Seeds the Address Element so a known billing address is not retyped. */
  billingAddress?: BillingAddress | null;
  initialOutcome?: SetupIntentOutcome | null;
  /**
   * Called after `confirmSetup` succeeds, carrying the id of the SetupIntent
   * that was just confirmed (null when it cannot be derived). Owners use this
   * to refresh the auto-top-up config so the saved-PM line and
   * `has_payment_method` gate reflect the new card immediately.
   *
   * The modal awaits it and titles its success panel with the resolved card,
   * so the parent re-renders against fresh data instead of briefly showing
   * stale payment-method copy after a successful save.
   */
  onSavedOptimistic: (args: {
    setupIntentId: string | null;
  }) => void | Promise<void | SavedPaymentMethod | null>;
}

/**
 * Modal that bootstraps a Stripe SetupIntent (via the heyapi mutation) and
 * mounts `<PaymentElement />` plus a billing-mode `<AddressElement />`
 * inside `<Elements>` so the user can save a card, with a billing address
 * for tax, on the org's Stripe customer to use for auto-top-up off-session
 * charges. The card is tagged via SetupIntent metadata so the webhook can
 * persist it onto AutoTopUpConfig. There is no separate auto-top-up Stripe
 * customer: auto-top-up uses the org's single Stripe customer (the same one
 * PaymentMethodViewSet uses).
 *
 * Flow:
 *  1. Modal opens, fire `organizationsBillingAutoTopUpSetupIntentCreate`
 *     to fetch a `client_secret`.
 *  2. While pending, and on through the Stripe iframes' own boot,
 *     render one field-shaped skeleton.
 *  3. On error, render a `Notice tone="error"` with a "Try again" button
 *     that re-runs the mutation.
 *  4. On success, mount `<SetupCardForm />` inside `<Elements>` and let the
 *     user submit. `confirmSetup({redirect: "if_required"})` resolves
 *     in-page when the PM doesn't need 3DS, and otherwise redirects to
 *     `window.location.href` (so the user lands back on the current
 *     settings page and `initialOutcome` replays the result).
 *  5. On success, `onSavedOptimistic({ setupIntentId })`, then the success
 *     panel, then `onClose()` after `SAVED_AUTO_CLOSE_MS`.
 */
export function AutoTopUpPaymentMethodModal(
  props: AutoTopUpPaymentMethodModalProps,
) {
  // Native Android saves cards on the web app's billing page in the browser
  // instead of mounting Stripe Elements in-app.
  const handsOff = useAndroidBillingHandoff({
    open: props.open,
    path: routes.settings.usageBilling,
    onClose: props.onClose,
  });
  if (handsOff) {
    return null;
  }
  return <AutoTopUpPaymentMethodModalContent {...props} />;
}

function AutoTopUpPaymentMethodModalContent({
  open,
  onClose,
  mode = "add",
  cardOnFile = null,
  billingAddress = null,
  initialOutcome = null,
  onSavedOptimistic,
}: AutoTopUpPaymentMethodModalProps) {
  const { t } = useTranslation("settings");
  const setupIntentMutation = useMutation(
    organizationsBillingAutoTopUpSetupIntentCreateMutation(),
  );
  // `mutate` / `reset` are stable across renders in TanStack Query 5; binding
  // to them (instead of the whole mutation object) keeps the effect deps
  // honest without re-firing on every render.
  const { mutate: createSetupIntent, reset: resetSetupIntent } =
    setupIntentMutation;

  const returnedSaved = initialOutcome?.kind === "saved";

  const [state, setState] = useState<PaymentMethodModalState>(
    returnedSaved ? "saved" : "idle",
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(
    initialOutcome?.kind === "error" ? initialOutcome.message : null,
  );
  const [savedCard, setSavedCard] = useState<SavedPaymentMethod | null>(
    initialOutcome?.kind === "saved" ? initialOutcome.card : null,
  );
  const [formComplete, setFormComplete] = useState(false);

  const requiresActionTimer = useRef<TimerHandle>(null);
  const savedCloseTimer = useRef<TimerHandle>(null);
  const mountedRef = useRef(true);
  const submitRef = useRef<(() => Promise<void>) | null>(null);
  // The reset effect below reads the outcome through a ref so a caller that
  // inlines the object cannot re-run the reset in the middle of a save. This
  // effect is declared first so the ref is current before the reset reads it.
  const outcomeRef = useRef(initialOutcome);
  useEffect(() => {
    outcomeRef.current = initialOutcome;
  }, [initialOutcome]);
  // The auto-close timer reads `onClose` through a ref so the scheduler stays
  // stable, which keeps the reset effect below firing on `open` alone even
  // when a caller inlines its handler.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimer(requiresActionTimer);
      clearTimer(savedCloseTimer);
    };
  }, []);

  // Every route into the success panel closes the modal on the same timer,
  // whether the card was saved in page or on a 3DS redirect return.
  const scheduleAutoClose = useCallback(() => {
    clearTimer(savedCloseTimer);
    savedCloseTimer.current = setTimeout(() => {
      onCloseRef.current();
    }, SAVED_AUTO_CLOSE_MS);
  }, []);

  // Seed each open from the redirect-return outcome and wipe everything on
  // close so a previous attempt cannot leak into the next open.
  useEffect(() => {
    clearTimer(requiresActionTimer);
    clearTimer(savedCloseTimer);
    const outcome = open ? outcomeRef.current : null;
    const savedOutcome = outcome?.kind === "saved" ? outcome : null;
    setState(savedOutcome ? "saved" : "idle");
    setErrorMessage(outcome?.kind === "error" ? outcome.message : null);
    setSavedCard(savedOutcome?.card ?? null);
    setFormComplete(false);
    if (savedOutcome) {
      scheduleAutoClose();
    }
  }, [open, scheduleAutoClose]);

  // Fire the SetupIntent fetch once each time the modal opens; reset on close
  // so a stale `client_secret` or error doesn't leak into the next open.
  // Skip the mutation when `STRIPE_PK` is empty (the modal can then only
  // render `<MissingStripeKeyNotice />`) or when a redirect already saved the
  // card, so neither case spawns a SetupIntent the user never completes.
  useEffect(() => {
    if (!open) {
      resetSetupIntent();
      return;
    }
    if (!STRIPE_PK || returnedSaved) {
      return;
    }
    createSetupIntent({});
  }, [open, returnedSaved, createSetupIntent, resetSetupIntent]);

  const clientSecret = setupIntentMutation.data?.client_secret ?? null;

  // A re-open, or a new client secret, boots fresh element instances, so the
  // skeleton takes the surface back until both report ready again.
  const [fieldsReady, setFieldsReady] = useState(false);
  // An element that fails to load never reports ready, so the skeleton would
  // otherwise hold the surface forever; this settles that wait into a retry.
  const [fieldsLoadError, setFieldsLoadError] = useState<string | null>(null);
  useEffect(() => {
    setFieldsReady(false);
    setFieldsLoadError(null);
  }, [open, clientSecret]);

  const handleFieldsLoadError = useCallback((message: string) => {
    setFieldsLoadError(message);
    // The form unmounts with the elements it failed to boot, so no later
    // completeness report can arrive to arm the primary action.
    setFormComplete(false);
  }, []);

  const theme = useDocumentTheme();
  // react-stripe-js forwards appearance changes to elements.update(), so a
  // theme toggle while the modal is open re-themes the iframes.
  const stripeAppearance = useMemo(() => buildStripeAppearance(theme), [theme]);

  const registerSubmit = useCallback((submit: () => Promise<void>) => {
    submitRef.current = submit;
  }, []);

  const handleSave = useCallback(
    async (confirm: () => Promise<SetupIntentResult>) => {
      setState("submitting");
      setErrorMessage(null);
      requiresActionTimer.current = setTimeout(() => {
        setState((current) =>
          current === "submitting" ? "requires_action" : current,
        );
      }, REQUIRES_ACTION_HINT_MS);

      try {
        const result = await confirm();
        // The bank has answered, so disarm the hint before the (possibly
        // slow) saved-card sync below can let it fire.
        clearTimer(requiresActionTimer);
        if (!mountedRef.current) {
          return;
        }
        if (result.error) {
          setState("error");
          setErrorMessage(
            result.error.code === "card_declined"
              ? t("autoTopUpPaymentMethodModal.declined")
              : (result.error.message ??
                  t("autoTopUpPaymentMethodModal.confirmFailed")),
          );
          return;
        }
        const saved = await onSavedOptimistic({
          setupIntentId: setupIntentIdFromClientSecret(clientSecret),
        });
        if (!mountedRef.current) {
          return;
        }
        setSavedCard(saved ?? null);
        setState("saved");
        scheduleAutoClose();
      } catch {
        // A rejection (Stripe throwing, or the saved-card sync failing) would
        // otherwise strand the modal in a locked state with no way out. The
        // card may in fact be saved; the page row reconciles from the config
        // query, so the generic copy is enough here.
        if (!mountedRef.current) {
          return;
        }
        setState("error");
        setErrorMessage(t("autoTopUpPaymentMethodModal.confirmFailed"));
      } finally {
        clearTimer(requiresActionTimer);
      }
    },
    [clientSecret, onSavedOptimistic, scheduleAutoClose, t],
  );

  const renderFields = () => {
    if (!STRIPE_PK) {
      // Short-circuit: when the publishable key is missing the mutation is
      // also skipped (see the effect above), so the no-client-secret branch
      // below would otherwise render a perpetual spinner.
      return <MissingStripeKeyNotice />;
    }
    if (returnedSaved) {
      return null;
    }
    if (setupIntentMutation.isError) {
      return (
        <div className="space-y-3" data-testid="auto-top-up-pm-modal-error">
          <Notice tone="error">
            {t("autoTopUpPaymentMethodModal.setupError")}
          </Notice>
          <div className="flex justify-end">
            <Button variant="primary" onClick={() => createSetupIntent({})}>
              {t("autoTopUpPaymentMethodModal.tryAgain")}
            </Button>
          </div>
        </div>
      );
    }
    if (fieldsLoadError) {
      // Both the skeleton and the elements go away with this branch: the
      // failed element will never paint, so nothing is left to reveal.
      // A retry mints a new client secret, which remounts <Elements> fresh.
      return (
        <div
          className="space-y-3"
          data-testid="auto-top-up-pm-modal-fields-error"
        >
          <Notice tone="error">{fieldsLoadError}</Notice>
          <div className="flex justify-end">
            <Button
              variant="primary"
              onClick={() => {
                setFieldsLoadError(null);
                createSetupIntent({});
              }}
            >
              {t("autoTopUpPaymentMethodModal.tryAgain")}
            </Button>
          </div>
        </div>
      );
    }
    // One skeleton spans the SetupIntent fetch and the iframes' boot: it
    // stays mounted while the elements arrive underneath, so the shimmer
    // never restarts mid-wait.
    return (
      <div className="relative">
        {fieldsReady ? null : <FieldSkeletons />}
        {clientSecret ? (
          // Revealed in place: mounting this wrapper at the flip would tear
          // <Elements> down and back up, destroying the iframes we just waited
          // for, so `fieldsReady` drives the fade instead. `absolute` keeps the
          // booting iframes out of the flow so the skeleton sets the height.
          <div
            className={cn(
              FIELD_STACK_CLASS,
              "transition-opacity duration-200 ease-out motion-reduce:transition-none",
              fieldsReady
                ? "opacity-100"
                : "invisible absolute inset-x-0 top-0 opacity-0",
            )}
          >
            <Elements
              // A new client secret boots new element instances, and it is
              // also when `fieldsReady` resets: keying the provider makes
              // those the same event, so the reset can never outlive the
              // readiness this form last reported.
              key={clientSecret}
              stripe={getStripePromise()}
              options={{
                clientSecret,
                appearance: stripeAppearance,
                fonts: STRIPE_FONTS,
                // Our skeleton already covers the iframe boot; Stripe's own
                // loader would be a second loading language on top of it.
                loader: "never",
              }}
            >
              <SetupCardForm
                billingAddress={billingAddress}
                onCompleteChange={setFormComplete}
                onFieldsLoadError={handleFieldsLoadError}
                onFieldsReady={setFieldsReady}
                onSave={handleSave}
                onSubmitReady={registerSubmit}
              />
            </Elements>
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <PaymentMethodModalShell
      open={open}
      mode={mode}
      state={state}
      cardOnFile={mode === "replace" ? cardOnFile : null}
      savedCard={savedCard}
      autoReloadActive={savedCard?.autoReloadEnabled ?? false}
      // A redirect return reopens straight into `saved`, where `mode` was
      // never chosen by the user and so cannot title the modal.
      headerless={returnedSaved}
      errorMessage={errorMessage}
      showTerms={CUSTOM_TERMS_APPROVED}
      submitDisabled={!formComplete}
      onClose={onClose}
      onSubmit={() => {
        void submitRef.current?.();
      }}
    >
      {renderFields()}
    </PaymentMethodModalShell>
  );
}

type TimerHandle = ReturnType<typeof setTimeout> | null;

function clearTimer(ref: { current: TimerHandle }): void {
  if (ref.current !== null) {
    clearTimeout(ref.current);
    ref.current = null;
  }
}

/**
 * Stripe seeds an address only when it knows the country, so an address
 * without one leaves the element empty rather than half-filled.
 */
function toStripeAddress(address: BillingAddress) {
  if (!address.country) {
    return undefined;
  }
  return {
    country: address.country,
    line1: address.line1 ?? undefined,
    line2: address.line2 ?? undefined,
    city: address.city ?? undefined,
    state: address.state ?? undefined,
    postal_code: address.postal_code ?? undefined,
  };
}

// Fallback when VITE_STRIPE_PUBLISHABLE_KEY is not set at build time.

function MissingStripeKeyNotice() {
  const { t } = useTranslation("settings");
  useEffect(() => {
    console.warn(
      "[AutoTopUpPaymentMethodModal] VITE_STRIPE_PUBLISHABLE_KEY is not set; the payment-method modal cannot mount Stripe Elements.",
    );
  }, []);
  return (
    <Notice tone="error">{t("autoTopUpPaymentMethodModal.unavailable")}</Notice>
  );
}

// ---------------------------------------------------------------------------
// SetupCardForm renders inside the `<Elements>` provider above so it can call
// `useStripe` / `useElements`. It owns only the two elements: the shell owns
// the form, the actions and the error line, so the form reports completeness
// upward and hands its submit function to the shell's primary action.
// ---------------------------------------------------------------------------

function SetupCardForm({
  billingAddress,
  onCompleteChange,
  onFieldsLoadError,
  onFieldsReady,
  onSave,
  onSubmitReady,
}: {
  billingAddress: BillingAddress | null;
  onCompleteChange: (complete: boolean) => void;
  /**
   * An element failed to boot, so it will never report ready. The parent owns
   * the message: it drops this form for a retry rather than leaving the
   * skeleton up beside an error line.
   */
  onFieldsLoadError: (message: string) => void;
  /** Both elements have painted, so the parent can drop its skeleton. */
  onFieldsReady: (ready: boolean) => void;
  onSave: (confirm: () => Promise<SetupIntentResult>) => Promise<void>;
  onSubmitReady: (submit: () => Promise<void>) => void;
}) {
  const { t } = useTranslation("settings");
  const stripe = useStripe();
  const elements = useElements();
  const user = useAuthStore.use.user();
  const email = user?.email ?? null;
  const fullName = [user?.firstName, user?.lastName].filter(Boolean).join(" ");

  const [paymentReady, setPaymentReady] = useState(false);
  const [addressReady, setAddressReady] = useState(false);
  const [paymentComplete, setPaymentComplete] = useState(false);
  const [addressComplete, setAddressComplete] = useState(false);

  const ready = paymentReady && addressReady;
  // Invariant: every mount reports readiness from scratch, so the parent's
  // `fieldsReady` reset (keyed on [open, clientSecret]) is never left holding
  // a report from a previous set of elements.
  useEffect(() => {
    onFieldsReady(ready);
  }, [onFieldsReady, ready]);

  const complete = ready && paymentComplete && addressComplete;
  useEffect(() => {
    onCompleteChange(complete);
  }, [complete, onCompleteChange]);

  const submit = useCallback(async () => {
    if (!stripe || !elements) {
      return;
    }
    await onSave(() =>
      stripe.confirmSetup({
        elements,
        confirmParams: {
          return_url: window.location.href,
          // The Payment Element hides the email field when the account
          // already knows it, so pass it through to the PaymentMethod.
          ...(email
            ? { payment_method_data: { billing_details: { email } } }
            : {}),
        },
        redirect: "if_required",
      }),
    );
  }, [elements, email, onSave, stripe]);

  useEffect(() => {
    onSubmitReady(submit);
  }, [onSubmitReady, submit]);

  return (
    <>
      <PaymentElement
        onReady={() => setPaymentReady(true)}
        onChange={(event) => setPaymentComplete(event.complete)}
        onLoadError={() =>
          onFieldsLoadError(
            t("autoTopUpPaymentMethodModal.paymentFormLoadError"),
          )
        }
        options={{
          layout: { type: "tabs", defaultCollapsed: false },
          // Link rides in the card form as a wallet; the SetupIntent stays
          // card-only, so saved PaymentMethods keep a `card` type with a real
          // brand and last4.
          wallets: { link: "auto", applePay: "never", googlePay: "never" },
          // The Address Element below owns the billing address (the saved PM
          // needs it for tax) and always collects a name, so both are
          // suppressed here. `defaultValues` is deliberately not passed: a
          // Link member's email there would mount an OTP takeover ahead of the
          // card fields.
          fields: {
            billingDetails: {
              name: "never",
              address: "never",
              email: email ? "never" : "auto",
            },
          },
          terms: { card: CUSTOM_TERMS_APPROVED ? "never" : "auto" },
        }}
      />
      {/*
        Billing address for tax: mounted in the same <Elements> group, the
        Address Element's value is attached to the PaymentMethod's
        billing_details automatically by `stripe.confirmSetup({ elements })`.
        The Django webhook seeds `customer.address` from it.
      */}
      <AddressElement
        onReady={() => setAddressReady(true)}
        onChange={(event) => setAddressComplete(event.complete)}
        onLoadError={() =>
          onFieldsLoadError(
            t("autoTopUpPaymentMethodModal.addressFormLoadError"),
          )
        }
        options={{
          mode: "billing",
          autocomplete: { mode: "automatic" },
          fields: { phone: "never" },
          defaultValues: {
            name: fullName || undefined,
            address: billingAddress
              ? toStripeAddress(billingAddress)
              : undefined,
          },
        }}
      />
    </>
  );
}
