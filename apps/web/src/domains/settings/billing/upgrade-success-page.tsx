import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Navigate, useNavigate } from "react-router";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
    organizationsBillingSubscriptionRetrieveOptions,
    organizationsBillingSubscriptionRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import {
    useActiveAssistantIsPlatformHosted,
    useActiveAssistantLifecycleIsLoading,
    usePlatformGate,
} from "@/hooks/use-platform-gate";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { Notice } from "@vellumai/design-library/components/notice";
import { Typography } from "@vellumai/design-library/components/typography";

/**
 * Stripe-redirect-vs-webhook-delivery race window.
 *
 * When Stripe Checkout completes, the user is redirected back to this page
 * before `customer.subscription.created` is guaranteed to have been processed
 * by the webhook handler. During that window `BillingAccount.plan_id` may
 * still read `"base"`. We poll `GET /v1/billing/subscription/` every second
 * until `plan_id === "pro"` or until the timeout fires.
 */

export const POLL_INTERVAL_MS = 1000;
export const POLL_TIMEOUT_MS = 10_000;
export const SUCCESS_REDIRECT_DELAY_MS = 2500;

export function UpgradeSuccessPage() {
  // Same predicate as the billing page itself for the page-level chrome.
  const platformGate = usePlatformGate({ platformHostedOnly: true });
  // Strict hosting predicate for the *Fetch*-tier `enabled` below.
  // `platformGate === "full"` is permissive during the lifecycle-loading
  // window — using it alone for `enabled` would let the subscription poll
  // start before we know whether the assistant is hosted. Pair with
  // `useActiveAssistantIsPlatformHosted()` so polling only kicks off after
  // positive hosted resolution (matches the notifications-page pattern from
  // PR-2.5 / Trap 6).
  const isPlatformHosted = useActiveAssistantIsPlatformHosted();
  // Distinguish the genuine *resolving* window from terminal-non-hosted
  // states. We let the resolving window fall through to PendingState (the
  // existing "Finalizing your upgrade…" UX) since polling is still
  // disabled there. Terminal-non-hosted gets its own Notice branch below
  // so the user isn't stuck staring at PendingState forever.
  const isLifecycleLoading = useActiveAssistantLifecycleIsLoading();
  // Polling is allowed only after lifecycle resolves *positively* to
  // hosted. Used to gate both the query's `enabled` and the timeout that
  // disables `refetchInterval` — see effect below.
  const isPollingEnabled = platformGate === "full" && isPlatformHosted;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [pollExpired, setPollExpired] = useState(false);

  // Force a refetch on mount so we don't read a stale cached "base" entry
  // from the billing page the user just left.
  useEffect(() => {
    void queryClient.invalidateQueries({
      queryKey: organizationsBillingSubscriptionRetrieveQueryKey(),
    });
  }, [queryClient]);

  const { data: queryData, isError: queryIsError } = useQuery({
    ...organizationsBillingSubscriptionRetrieveOptions(),
    // Fetch-tier predicate: strict on `isPlatformHosted`, not just the
    // page-level `platformGate === "full"`. During the lifecycle-loading
    // window `platformGate === "full"` and `isPlatformHosted === false`,
    // and the poll would otherwise start firing org-scoped requests
    // before we know the assistant is hosted. Wait for positive
    // resolution; either the query fires (hosted) or the body's
    // `<Navigate />` takes over (gated).
    enabled: isPollingEnabled,
    // Stop polling once we observe Pro OR the timeout fires.
    refetchInterval: (query) => {
      const planId = query.state.data?.plan_id;
      if (planId === "pro" || pollExpired) return false;
      return POLL_INTERVAL_MS;
    },
    refetchIntervalInBackground: false,
  });
  // Cached-data leak guard (Trap 6 cached-state variant — banked on PR-2.5
  // commit `49c35d7c3`, restated for new code on this PR).
  //
  // `useQuery` with `enabled: false` still exposes cached `data` / `isError`
  // from any prior visit to billing in the same session. A user who saw
  // `plan_id: "pro"` earlier and then re-enters via Stripe's success URL
  // would have `queryData.plan_id === "pro"` in the lifecycle-loading
  // window BEFORE any actual poll runs — `reachedPro` flips true, success
  // state renders, redirect fires, all before we've confirmed hosting.
  //
  // Re-derive every observer-state piece through the same gate that's on
  // `enabled`. This keeps the page in PendingState until polling is
  // genuinely active, regardless of cache contents.
  const data = isPollingEnabled ? queryData : undefined;
  const isError = isPollingEnabled ? queryIsError : false;

  // Hard timeout: even if Stripe + the webhook never converge, stop
  // hammering. Tied to `isPollingEnabled` so the 10-second clock starts
  // *after* polling actually becomes possible — otherwise a cold Stripe
  // redirect that spends >10s resolving lifecycle would set `pollExpired`
  // before a single request fired, and the very first response would
  // immediately disable `refetchInterval` (ProcessingFallbackState with
  // no actual polling). Cleanup clears the timer if polling gets
  // disabled again (gated/disabled mid-flight).
  useEffect(() => {
    if (!isPollingEnabled) return;
    const t = setTimeout(() => setPollExpired(true), POLL_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [isPollingEnabled]);

  const reachedPro = data?.plan_id === "pro";

  // Auto-redirect after success state has rendered for SUCCESS_REDIRECT_DELAY_MS.
  useEffect(() => {
    if (!reachedPro) return;
    const t = setTimeout(() => {
      navigate(routes.settings.billing, { replace: true });
    }, SUCCESS_REDIRECT_DELAY_MS);
    return () => clearTimeout(t);
  }, [reachedPro, navigate]);

  const goToBilling = () => navigate(routes.settings.billing, { replace: true });

  // Whole-page gates: same Navigate/chrome pattern as `billing-page.tsx`. The
  // hooks above all ran (with `enabled: false` for the query) so React's
  // hooks-order invariant holds.
  if (platformGate === "gated") {
    return <Navigate replace to={routes.settings.general} />;
  }
  if (platformGate === "disabled") {
    return (
      <div className="max-w-4xl space-y-6">
        <Notice tone="info">
          Log in to the Vellum platform to manage billing and usage.
        </Notice>
      </div>
    );
  }

  // Terminal non-hosted (resolved to `retired`, `error`): polling
  // never becomes enabled, so
  // PendingState would render "Finalizing your upgrade…" forever.
  // Short-circuit to a Notice with a manual escape hatch. Lifecycle-
  // loading + transitional states (`loading`, `initializing`,
  // `cleaning_up`) all fall through to the body via `isLifecycleLoading`
  // — PendingState is the right UX there.
  if (!isPollingEnabled && !isLifecycleLoading) {
    return (
      <div className="max-w-4xl space-y-6">
        <Notice tone="warning">
          We can&apos;t confirm your upgrade for the current assistant.
          Return to billing to retry.
        </Notice>
        <div className="flex justify-end">
          <Button
            variant="primary"
            data-testid="upgrade-success-go-to-billing"
            onClick={goToBilling}
          >
            Go to billing
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl space-y-6">
      <Card padding="lg">
        {reachedPro ? (
          <SuccessState />
        ) : isError ? (
          <FetchErrorState />
        ) : pollExpired ? (
          <ProcessingFallbackState />
        ) : (
          <PendingState />
        )}
        {(reachedPro || isError || pollExpired) && (
          <div className="mt-4 flex justify-end">
            <Button
              variant={reachedPro || isError ? "primary" : "outlined"}
              data-testid="upgrade-success-go-to-billing"
              onClick={goToBilling}
            >
              Go to billing
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}

function PendingState() {
  return (
    <div className="flex flex-col items-center gap-3 py-6 text-center">
      <Loader2
        className="h-6 w-6 animate-spin text-[var(--content-secondary)]"
        aria-hidden="true"
      />
      <Typography variant="title-small" as="h1">
        Finalizing your upgrade…
      </Typography>
      <Typography
        variant="body-medium-lighter"
        as="p"
        className="text-[var(--content-secondary)]"
      >
        Stripe is confirming your subscription. This usually takes a few
        seconds.
      </Typography>
    </div>
  );
}

function SuccessState() {
  return (
    <div className="flex flex-col items-center gap-3 py-6 text-center">
      <CheckCircle2
        className="h-8 w-8 text-[var(--system-positive-strong)]"
        aria-hidden="true"
      />
      <Typography variant="title-small" as="h1">
        Welcome to Pro
      </Typography>
      <Typography
        variant="body-medium-lighter"
        as="p"
        className="text-[var(--content-secondary)]"
      >
        Your Pro plan is active. You&apos;ll be redirected back to billing in a
        moment.
      </Typography>
    </div>
  );
}

function ProcessingFallbackState() {
  return (
    <Notice tone="warning">
      We&apos;re processing your upgrade — refresh in a moment to see your new
      plan.
    </Notice>
  );
}

function FetchErrorState() {
  return (
    <div className="flex flex-col items-center gap-3 py-6 text-center">
      <AlertCircle
        className="h-8 w-8 text-[var(--system-negative-strong)]"
        aria-hidden="true"
      />
      <Typography variant="title-small" as="h1">
        Couldn&apos;t reach billing
      </Typography>
      <Typography
        variant="body-medium-lighter"
        as="p"
        className="text-[var(--content-secondary)]"
      >
        We hit a problem checking your subscription. Your upgrade may still be
        processing — return to billing to refresh.
      </Typography>
    </div>
  );
}
