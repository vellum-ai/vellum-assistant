import { useEffect, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { useQueryClient } from "@tanstack/react-query";

import {
    clearPortalReturnSnapshot,
    formatGraceDate,
    type PortalReturnSnapshot,
    readPortalReturnSnapshot,
} from "@/domains/settings/hooks/use-billing-portal-session";
import {
    organizationsBillingSubscriptionRetrieveOptions,
    organizationsBillingSubscriptionRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import { routes } from "@/utils/routes";
import { toast } from "@vellumai/design-library/components/toast";

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 15000;
const BACKGROUND_POLL_INTERVAL_MS = 3000;
const BACKGROUND_POLL_TIMEOUT_MS = 45000;
const TOAST_ID = "billing-portal-return";

interface SubscriptionDelta {
  cancel_at_period_end: boolean;
  cancel_at: string | null;
}

export function pickPortalReturnToast(
  snapshot: PortalReturnSnapshot | null,
  current: SubscriptionDelta,
): { kind: "info" | "success"; message: string } {
  if (!snapshot) {
    return { kind: "info", message: "Subscription updated." };
  }
  const wasCancelling =
    snapshot.cancel_at_period_end || Boolean(snapshot.cancel_at);
  const isCancelling =
    current.cancel_at_period_end || Boolean(current.cancel_at);
  if (!wasCancelling && isCancelling) {
    const date = current.cancel_at
      ? formatGraceDate(current.cancel_at)
      : "the end of your billing period";
    return {
      kind: "info",
      message: `Pro plan canceled. You'll have access until ${date}.`,
    };
  }
  if (wasCancelling && !isCancelling) {
    return { kind: "success", message: "Pro plan reactivated." };
  }
  return { kind: "info", message: "Subscription updated." };
}

/**
 * Mounted on the billing settings page. When the URL carries
 * `?portal_return=true` (Stripe Customer Portal redirect target), reads the
 * pre-redirect snapshot from sessionStorage, polls the subscription endpoint
 * until the cancel flag flips or a short timeout elapses, then surfaces a
 * contextual toast and strips the query param.
 */
export function BillingPortalReturnHandler() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (searchParams.get("portal_return") !== "true") return;

    // Per-effect-run cancellation tracker. In React Strict Mode (dev) the
    // effect runs twice: the first run's cleanup flips this to true and the
    // first IIFE bails; the second run starts fresh and completes normally.
    // In production the effect runs once. Real unmount mid-poll also bails.
    const unmountedRef = { current: false };

    const snapshot = readPortalReturnSnapshot();
    const queryOptions = organizationsBillingSubscriptionRetrieveOptions();
    const queryKey = organizationsBillingSubscriptionRetrieveQueryKey();
    const start = Date.now();

    async function fetchLatest(): Promise<SubscriptionDelta> {
      await queryClient.invalidateQueries({ queryKey });
      const data = await queryClient.fetchQuery(queryOptions);
      return {
        cancel_at_period_end: data.cancel_at_period_end,
        cancel_at: data.cancel_at,
      };
    }

    async function poll(): Promise<SubscriptionDelta> {
      let latest = await fetchLatest();
      while (
        !unmountedRef.current &&
        snapshot &&
        latest.cancel_at_period_end === snapshot.cancel_at_period_end &&
        latest.cancel_at === snapshot.cancel_at &&
        Date.now() - start < POLL_TIMEOUT_MS
      ) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        if (unmountedRef.current) break;
        latest = await fetchLatest();
      }
      return latest;
    }

    void (async () => {
      try {
        const current = await poll();
        if (unmountedRef.current) return;
        const { kind, message } = pickPortalReturnToast(snapshot, current);
        if (kind === "success") {
          toast.success(message, { id: TOAST_ID });
        } else {
          toast.info(message, { id: TOAST_ID });
        }
      } catch {
        if (unmountedRef.current) return;
        toast.info("Subscription updated.", { id: TOAST_ID });
      } finally {
        if (!unmountedRef.current) {
          clearPortalReturnSnapshot();
          navigate(routes.settings.billing, { replace: true });
          const backgroundStart = Date.now();
          if (intervalRef.current !== null) {
            clearInterval(intervalRef.current);
          }
          intervalRef.current = setInterval(() => {
            if (
              Date.now() - backgroundStart >= BACKGROUND_POLL_TIMEOUT_MS
            ) {
              if (intervalRef.current !== null) {
                clearInterval(intervalRef.current);
                intervalRef.current = null;
              }
              return;
            }
            void fetchLatest().catch((err) => {
              console.error("billing poll error:", err);
            });
          }, BACKGROUND_POLL_INTERVAL_MS);
        }
      }
    })();

    return () => {
      unmountedRef.current = true;
    };
  }, [searchParams, navigate, queryClient]);

  return null;
}
