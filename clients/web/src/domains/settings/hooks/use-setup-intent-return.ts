import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import {
  getStripePromise,
  setupIntentIdFromClientSecret,
} from "@/domains/settings/billing/stripe-client";
import type { SetupIntentOutcome } from "@/domains/settings/components/auto-top-up-payment-method-modal";
import { usePaymentMethodSavedSync } from "@/domains/settings/hooks/use-payment-method-saved-poll";
import { useOrgHeaderReadiness } from "@/hooks/use-is-org-ready";
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
 *
 * `pending` spans the window between reading those params and settling them,
 * which the confirm fallback's webhook poll can stretch to 20 seconds. The
 * outcome is replayed into a modal the caller opens for it, so the caller uses
 * `pending` to keep a competing one from being opened first.
 */
export function useSetupIntentReturn(): {
  outcome: SetupIntentOutcome | null;
  pending: boolean;
  clearOutcome: () => void;
} {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const syncPaymentMethodSaved = usePaymentMethodSavedSync();
  const orgReadiness = useOrgHeaderReadiness();

  const [captured, setCaptured] = useState<CapturedReturn | null>(null);
  const [outcome, setOutcome] = useState<SetupIntentOutcome | null>(null);
  // Tracked apart from `outcome` so `clearOutcome()` does not read as a return
  // that went back to being unresolved.
  const [settled, setSettled] = useState(false);
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
  // to the 20-second webhook poll, so the resolution waits out `"resolving"`
  // exactly as the config query does. `"unavailable"` still resolves: the
  // request fires and fails into the error outcome, rather than leaving the
  // return unresolved for the rest of the visit.
  useEffect(() => {
    if (
      captured == null ||
      orgReadiness === "resolving" ||
      resolvedRef.current
    ) {
      return;
    }
    resolvedRef.current = true;
    const { clientSecret, redirectStatus } = captured;

    const settle = (next: SetupIntentOutcome) => {
      if (mountedRef.current) {
        setOutcome(next);
        setSettled(true);
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
  }, [captured, orgReadiness, syncPaymentMethodSaved]);

  const clearOutcome = useCallback(() => setOutcome(null), []);

  return { outcome, pending: captured != null && !settled, clearOutcome };
}
