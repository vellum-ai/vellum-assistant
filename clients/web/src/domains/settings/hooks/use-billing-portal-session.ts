import { useEffect } from "react";

import { useQueryClient } from "@tanstack/react-query";

import {
    organizationsBillingSubscriptionRetrieveOptions,
    useOrganizationsBillingPortalSessionCreateMutation,
} from "@/generated/api/@tanstack/react-query.gen";
import { openUrl, openUrlFinishedListener } from "@/runtime/browser";
import { toast } from "@vellumai/design-library/components/toast";

export const PORTAL_RETURN_SNAPSHOT_KEY = "billing-portal-return-snapshot";

export interface PortalReturnSnapshot {
  cancel_at_period_end: boolean;
  cancel_at: string | null;
  plan_id: string;
}

export function writePortalReturnSnapshot(snapshot: PortalReturnSnapshot): void {
  try {
    // Clear any stale snapshot before writing. If setItem then throws
    // (quota / private mode), the return-handler falls back to the generic
    // toast instead of reading a stale contextual one.
    sessionStorage.removeItem(PORTAL_RETURN_SNAPSHOT_KEY);
    sessionStorage.setItem(
      PORTAL_RETURN_SNAPSHOT_KEY,
      JSON.stringify(snapshot),
    );
  } catch {
    // sessionStorage may be unavailable (private mode, SSR). Snapshot miss
    // is handled in the return-toast component; safe to swallow here.
  }
}

export function readPortalReturnSnapshot(): PortalReturnSnapshot | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(PORTAL_RETURN_SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PortalReturnSnapshot>;
    if (
      typeof parsed.cancel_at_period_end !== "boolean" ||
      typeof parsed.plan_id !== "string"
    ) {
      return null;
    }
    return {
      cancel_at_period_end: parsed.cancel_at_period_end,
      cancel_at: parsed.cancel_at ?? null,
      plan_id: parsed.plan_id,
    };
  } catch {
    return null;
  }
}

export function clearPortalReturnSnapshot(): void {
  try {
    sessionStorage.removeItem(PORTAL_RETURN_SNAPSHOT_KEY);
  } catch {
    // see writePortalReturnSnapshot
  }
}

/**
 * Build a `PortalReturnSnapshot` from a subscription-retrieve query result.
 * The snapshot is captured pre-redirect so the post-portal-return handler
 * can diff old vs new state. Returns `null` while subscription data is
 * loading; the hook accepts `null` snapshots (no diff is recorded).
 */
export function buildPortalReturnSnapshot(
  data:
    | {
        cancel_at_period_end: boolean;
        cancel_at: string | null | undefined;
        plan_id: string;
      }
    | undefined,
): PortalReturnSnapshot | null {
  if (!data) return null;
  return {
    cancel_at_period_end: data.cancel_at_period_end,
    cancel_at: data.cancel_at ?? null,
    plan_id: data.plan_id,
  };
}

/**
 * Format an ISO timestamp as a locale date (date-only). Falls back to the
 * raw string if the value isn't parseable so we never render "Invalid Date".
 */
export function formatGraceDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * Resolve the effective cancel/end date for a subscription. Stripe sometimes
 * surfaces `cancel_at_period_end=true` without populating an explicit
 * `cancel_at` (e.g. mid-grace edge cases); fall back to `current_period_end`
 * so callers can still render an "ends on …" date instead of vanishing.
 *
 * Returns null when neither field is populated.
 */
export function getEffectiveCancelDate(
  data:
    | {
        cancel_at: string | null | undefined;
        current_period_end: string | null | undefined;
      }
    | undefined
    | null,
): string | null {
  if (!data) return null;
  return data.cancel_at ?? data.current_period_end ?? null;
}

export function useBillingPortalSession(snapshot: PortalReturnSnapshot | null) {
  const queryClient = useQueryClient();

  // On native iOS, the Stripe Customer Portal opens in
  // SFSafariViewController (an overlay outside the WKWebView). When the
  // user dismisses it, the host page never sees `?portal_return=true`, so
  // BillingPortalReturnHandler does not fire. Refetch the subscription
  // directly on dismissal so cancel/reactivate state surfaces immediately.
  // No-op on web (the listener is registered only on Capacitor native).
  useEffect(() => {
    return openUrlFinishedListener(() => {
      void queryClient.invalidateQueries(
        organizationsBillingSubscriptionRetrieveOptions(),
      );
    });
  }, [queryClient]);

  return useOrganizationsBillingPortalSessionCreateMutation({
    onSuccess: (data) => {
      if (snapshot) {
        writePortalReturnSnapshot(snapshot);
      }
      // Capacitor-aware: routes through SFSafariViewController on native iOS
      // (where same-tab navigation breaks the round-trip) and falls back to
      // window.location.href on web.
      void openUrl(data.portal_url);
    },
    onError: () => {
      toast.error("Couldn't open the billing portal. Please try again.", {
        id: "billing-portal-session-error",
      });
    },
  });
}
