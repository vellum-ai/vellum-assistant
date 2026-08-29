import { useEffect, useRef } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";

import {
  getStripePromise,
  setupIntentIdFromClientSecret,
} from "@/domains/settings/billing/stripe-client";
import {
  usePaymentMethodSavedSync,
  type SavedPaymentMethod,
} from "@/domains/settings/hooks/use-payment-method-saved-poll";
import { useSetupIntentReturnStore } from "@/domains/settings/setup-intent-return-store";
import { replaceSearchParams } from "@/domains/settings/utils/replace-search-params";
import { awaitOrgHeaderSettled } from "@/hooks/await-org-header-settled";
import { t } from "@/i18n";
import { useAuthStore } from "@/stores/auth-store";
import { isPlatformSessionSettled } from "@/stores/session-status";

const CLIENT_SECRET_PARAM = "setup_intent_client_secret";
const REDIRECT_STATUS_PARAM = "redirect_status";

/** What Stripe appends to the `return_url`, and what the strip below drops. */
const STRIPE_RETURN_PARAMS = [
  "setup_intent",
  CLIENT_SECRET_PARAM,
  REDIRECT_STATUS_PARAM,
];

type ConfirmSaved = (args: {
  setupIntentId: string | null;
}) => Promise<SavedPaymentMethod | null>;

/**
 * The confirm below writes the saved card through the QueryClient captured
 * when the resolution started, and that client is keyed on the request scope:
 * the signed-in user as well as the organization. A 3DS return is a full page
 * load, where the local-gateway path authenticates a placeholder user while
 * the platform-session probe is still `"unknown"`, and the probe swapping in
 * the real user remounts the client. Waiting the probe out keeps the confirm's
 * writes on the client the cards read.
 */
function requestScopeSettled(): boolean {
  return isPlatformSessionSettled(useAuthStore.getState().platformSession);
}

/**
 * Resolves the captured params into the outcome the modal replays and writes
 * it to the store. A plain function rather than an effect body, so it outlives
 * whatever mounted the hook that started it.
 */
async function resolveSetupIntentReturn({
  clientSecret,
  redirectStatus,
  confirmSaved,
}: {
  clientSecret: string;
  redirectStatus: string | null;
  confirmSaved: ConfirmSaved;
}): Promise<void> {
  const { settleOutcome } = useSetupIntentReturnStore.getState();

  const settleError = (message: string | undefined) => {
    console.warn("[useSetupIntentReturn] card not saved on redirect return", {
      redirectStatus,
    });
    settleOutcome({
      kind: "error",
      message:
        message ?? t("settings:autoTopUpPaymentMethodModal.confirmFailed"),
    });
  };

  // A full-page 3DS return remounts the app, so the org store can still be
  // hydrating when the params are read. The confirm below needs
  // `Vellum-Organization-Id`, and a headerless one is rejected and falls back
  // to the 20-second webhook poll. Past the ceiling, and for `"unavailable"`,
  // the request fires and fails into the error outcome instead.
  await awaitOrgHeaderSettled({ alsoReady: requestScopeSettled });

  try {
    const stripe = await getStripePromise();
    if (stripe == null) {
      settleError(undefined);
      return;
    }
    const { setupIntent, error } =
      await stripe.retrieveSetupIntent(clientSecret);
    if (setupIntent?.status === "succeeded") {
      const card = await confirmSaved({
        setupIntentId: setupIntentIdFromClientSecret(clientSecret),
      });
      settleOutcome({ kind: "saved", card });
      return;
    }
    settleError(error?.message ?? setupIntent?.last_setup_error?.message);
  } catch {
    settleError(undefined);
  }
}

/**
 * Drives the SetupIntent params Stripe appends to the `return_url` after an
 * off-page 3DS challenge (`setup_intent`, `setup_intent_client_secret`,
 * `redirect_status`): they are read once, stripped from the URL, and resolved
 * into the outcome `AutoTopUpPaymentMethodModal` replays as its
 * `initialOutcome`. The result lands in `useSetupIntentReturnStore`, which is
 * where the cards read it from.
 *
 * `redirect_status` is a hint only: the SetupIntent is re-read through
 * Stripe.js, and a succeeded one is confirmed server-side through
 * `usePaymentMethodSavedSync`, so the success panel and the payment-method row
 * carry the new card's brand and last4.
 *
 * Call this once ABOVE the billing tab panel (it lives in `BillingPage`). The
 * panel unmounts on a switch to the Usage tab and the params are off the URL
 * by then, so a return driven from inside it would be lost for the rest of the
 * visit.
 */
export function useSetupIntentReturn(): void {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const syncPaymentMethodSaved = usePaymentMethodSavedSync();

  const capturedRef = useRef(false);

  useEffect(() => {
    const clientSecret = searchParams.get(CLIENT_SECRET_PARAM);
    if (clientSecret == null || capturedRef.current) {
      return;
    }
    // One capture per page load: strict mode runs this effect twice, and
    // stripping the params below re-runs it a third time.
    capturedRef.current = true;
    const redirectStatus = searchParams.get(REDIRECT_STATUS_PARAM);

    replaceSearchParams(navigate, location, (next) => {
      for (const param of STRIPE_RETURN_PARAMS) {
        next.delete(param);
      }
      // Stripe's params are not billing intent, so a signed-out-but-reachable
      // viewer would lose the billing tab (and the outcome replayed into it)
      // the moment they are stripped.
      next.set("tab", "billing");
    });

    useSetupIntentReturnStore.getState().beginResolving();
    void resolveSetupIntentReturn({
      clientSecret,
      redirectStatus,
      confirmSaved: syncPaymentMethodSaved,
    });
    // `syncPaymentMethodSaved` is rebuilt every render, so this effect re-runs
    // often; the capture guard above makes every run after the first a no-op.
  }, [location, navigate, searchParams, syncPaymentMethodSaved]);
}
