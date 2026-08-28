import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import {
  getStripePromise,
  setupIntentIdFromClientSecret,
} from "@/domains/settings/billing/stripe-client";
import type { SetupIntentOutcome } from "@/domains/settings/components/auto-top-up-payment-method-modal";
import { usePaymentMethodSavedSync } from "@/domains/settings/hooks/use-payment-method-saved-poll";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { t } from "@/i18n";
import { routes } from "@/utils/routes";

/** The redirect params, held from the URL strip until the org store settles. */
interface CapturedReturn {
  clientSecret: string;
  redirectStatus: string | null;
}

/**
 * Resolves the SetupIntent params Stripe appends to the `return_url` after an
 * off-page 3DS challenge (`setup_intent`, `setup_intent_client_secret`,
 * `redirect_status`) into the outcome `AutoTopUpPaymentMethodModal` replays as
 * its `initialOutcome`, and strips them from the URL.
 *
 * `redirect_status` is a hint only: the SetupIntent is re-read through
 * Stripe.js, and a succeeded one is confirmed server-side through
 * `usePaymentMethodSavedSync`, so the success panel and the payment-method row
 * carry the new card's brand and last4.
 */
export function useSetupIntentReturn(): {
  outcome: SetupIntentOutcome | null;
  clearOutcome: () => void;
} {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const syncPaymentMethodSaved = usePaymentMethodSavedSync();
  const orgReady = useIsOrgReady();

  const [captured, setCaptured] = useState<CapturedReturn | null>(null);
  const [outcome, setOutcome] = useState<SetupIntentOutcome | null>(null);
  const capturedRef = useRef(false);
  const resolvedRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const clientSecret = searchParams.get("setup_intent_client_secret");
    if (clientSecret == null || capturedRef.current) {
      return;
    }
    // One capture per page load: strict mode runs this effect twice, and
    // stripping the params below re-runs it a third time.
    capturedRef.current = true;
    setCaptured({
      clientSecret,
      redirectStatus: searchParams.get("redirect_status"),
    });
    navigate(routes.settings.usageBilling, { replace: true });
  }, [navigate, searchParams]);

  // A full-page 3DS return remounts the app, so the org store can still be
  // hydrating when the params are read. The server-side confirm below needs
  // `Vellum-Organization-Id`, and a headerless one is rejected and falls back
  // to the 20-second webhook poll, so the resolution waits for the header
  // source the same way the billing queries do.
  useEffect(() => {
    if (captured == null || !orgReady || resolvedRef.current) {
      return;
    }
    resolvedRef.current = true;
    const { clientSecret, redirectStatus } = captured;

    const settle = (next: SetupIntentOutcome) => {
      if (mountedRef.current) {
        setOutcome(next);
      }
    };
    const settleError = (message: string | undefined) => {
      console.warn("[useSetupIntentReturn] card not saved on redirect return", {
        redirectStatus,
      });
      settle({
        kind: "error",
        message:
          message ?? t("settings:autoTopUpPaymentMethodModal.confirmFailed"),
      });
    };

    void (async () => {
      try {
        const stripe = await getStripePromise();
        if (stripe == null) {
          settleError(undefined);
          return;
        }
        const { setupIntent, error } =
          await stripe.retrieveSetupIntent(clientSecret);
        if (setupIntent?.status === "succeeded") {
          const card = await syncPaymentMethodSaved({
            setupIntentId: setupIntentIdFromClientSecret(clientSecret),
          });
          settle({ kind: "saved", card });
          return;
        }
        settleError(error?.message ?? setupIntent?.last_setup_error?.message);
      } catch {
        settleError(undefined);
      }
    })();
  }, [captured, orgReady, syncPaymentMethodSaved]);

  const clearOutcome = useCallback(() => setOutcome(null), []);

  return { outcome, clearOutcome };
}
