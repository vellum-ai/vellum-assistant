import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { useNavigate } from "react-router";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@vellum/design-library/components/button";
import { Card } from "@vellum/design-library/components/card";
import { Notice } from "@vellum/design-library/components/notice";
import { Typography } from "@vellum/design-library/components/typography";
import {
  organizationsBillingSubscriptionRetrieveOptions,
  organizationsBillingSubscriptionRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen.js";
import { routes } from "@/utils/routes.js";

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

  const { data, isError } = useQuery({
    ...organizationsBillingSubscriptionRetrieveOptions(),
    // Stop polling once we observe Pro OR the timeout fires.
    refetchInterval: (query) => {
      const planId = query.state.data?.plan_id;
      if (planId === "pro" || pollExpired) return false;
      return POLL_INTERVAL_MS;
    },
    refetchIntervalInBackground: false,
  });

  // Hard timeout: even if Stripe + the webhook never converge, stop hammering.
  useEffect(() => {
    const t = setTimeout(() => setPollExpired(true), POLL_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, []);

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
