import { Loader2 } from "lucide-react";
import { useMemo } from "react";

import { useQuery } from "@tanstack/react-query";

import { Button } from "@vellum/design-library/components/button";
import { Notice } from "@vellum/design-library/components/notice";
import { organizationsBillingSubscriptionRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import {
  buildPortalReturnSnapshot,
  formatGraceDate,
  getEffectiveCancelDate,
  useBillingPortalSession,
} from "@/domains/settings/hooks/use-billing-portal-session";

/**
 * In-flow banner shown on the billing settings surface when the org's Pro
 * subscription is mid-grace-period — i.e. cancellation has been scheduled,
 * either via `cancel_at_period_end=true` or via an explicit `cancel_at`
 * timestamp set by Stripe (the Customer Portal uses the latter). The
 * "Reactivate" CTA fires the Stripe Customer Portal mutation; Stripe handles
 * reactivation natively. We capture a pre-redirect snapshot so the
 * post-portal-return toast can diff old → new state.
 */
export function GracePeriodBanner() {
  const { data } = useQuery(organizationsBillingSubscriptionRetrieveOptions());

  const snapshot = useMemo(() => buildPortalReturnSnapshot(data), [data]);

  const portalMutation = useBillingPortalSession(snapshot);

  if (
    !data ||
    data.plan_id !== "pro" ||
    data.status === "canceled" ||
    (!data.cancel_at_period_end && !data.cancel_at)
  ) {
    return null;
  }
  const cancelDate = getEffectiveCancelDate(data);
  if (!cancelDate) return null;
  const formatted = formatGraceDate(cancelDate);

  return (
    <Notice
      tone="info"
      title={`Your Pro plan will end on ${formatted}.`}
      actions={
        <Button
          variant="outlined"
          size="compact"
          onClick={() => portalMutation.mutate({})}
          disabled={portalMutation.isPending}
          leftIcon={
            portalMutation.isPending ? (
              <Loader2 className="animate-spin" />
            ) : undefined
          }
          data-testid="grace-period-reactivate-button"
        >
          Reactivate
        </Button>
      }
      data-testid="grace-period-banner"
    >
      You&apos;ll keep Pro features until then.
    </Notice>
  );
}
