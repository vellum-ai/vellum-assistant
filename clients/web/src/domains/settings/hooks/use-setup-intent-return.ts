import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import {
  getStripePromise,
  setupIntentIdFromClientSecret,
} from "@/domains/settings/billing/stripe-client";
import type { SetupIntentOutcome } from "@/domains/settings/components/auto-top-up-payment-method-modal";
import { usePaymentMethodSavedSync } from "@/domains/settings/hooks/use-payment-method-saved-poll";
import { t } from "@/i18n";
import { routes } from "@/utils/routes";

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

  const [outcome, setOutcome] = useState<SetupIntentOutcome | null>(null);
  const handledRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const clientSecret = searchParams.get("setup_intent_client_secret");
    if (clientSecret == null || handledRef.current) {
      return;
    }
    // One resolution per page load: strict mode runs this effect twice, and
    // stripping the params below re-runs it a third time.
    handledRef.current = true;
    const redirectStatus = searchParams.get("redirect_status");
    navigate(routes.settings.usageBilling, { replace: true });

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
  }, [navigate, searchParams, syncPaymentMethodSaved]);

  const clearOutcome = useCallback(() => setOutcome(null), []);

  return { outcome, clearOutcome };
}
