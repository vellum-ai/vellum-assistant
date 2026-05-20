import { Crown, Loader2, Palmtree } from "lucide-react";

import { useQuery } from "@tanstack/react-query";

import { Button } from "@vellum/design-library/components/button";
import { Card } from "@vellum/design-library/components/card";
import { Notice } from "@vellum/design-library/components/notice";
import { SkillRow } from "@vellum/design-library/components/skill-row";
import { Typography } from "@vellum/design-library/components/typography";
import {
  organizationsBillingPlansRetrieveOptions,
  organizationsBillingSubscriptionRetrieveOptions,
} from "@/generated/api/@tanstack/react-query.gen.js";
import {
  formatGraceDate,
  getEffectiveCancelDate,
} from "@/domains/settings/hooks/use-billing-portal-session.js";

/**
 * PlanCard — top-of-billing-settings summary of the org's current plan.
 *
 * Renders a Card with a heading, a tinted SkillRow showing the current plan
 * (Pro / Base), and a renewal / cancellation caption underneath. Both the
 * Pro "Manage" and Base "Upgrade to Pro" buttons fan into the same
 * `onManage` callback — the parent owns modal open state.
 *
 * The cancel timestamp falls back to `current_period_end` when `cancel_at`
 * is null so the line still surfaces during the brief window between Stripe
 * scheduling cancellation and writing the explicit `cancel_at` field.
 */

export interface PlanCardProps {
  onManage: () => void;
}

function PlanHeading() {
  return (
    <div>
      <Typography
        as="h2"
        variant="title-medium"
        className="text-[var(--content-default)]"
      >
        Plan
      </Typography>
      <Typography
        as="p"
        variant="body-small-default"
        className="mt-2 text-[var(--content-tertiary)]"
      >
        Manage your subscription tier and billing.
      </Typography>
    </div>
  );
}

export function PlanCard({ onManage }: PlanCardProps) {
  const subscriptionQuery = useQuery(
    organizationsBillingSubscriptionRetrieveOptions(),
  );
  const plansQuery = useQuery(organizationsBillingPlansRetrieveOptions());

  if (subscriptionQuery.isLoading || plansQuery.isLoading) {
    return (
      <Card padding="md">
        <PlanHeading />
        <div className="mt-4 flex items-center gap-2 text-[var(--content-tertiary)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          <Typography as="span" variant="body-small-default">
            Loading plan...
          </Typography>
        </div>
      </Card>
    );
  }

  const subscription = subscriptionQuery.data;
  const plans = plansQuery.data?.plans;
  const currentPlan = plans?.find((p) => p.id === subscription?.plan_id);

  if (
    subscriptionQuery.isError ||
    plansQuery.isError ||
    !subscription ||
    !plans ||
    !currentPlan
  ) {
    return <Notice tone="error">Failed to load plan.</Notice>;
  }

  const isPro = subscription.plan_id === "pro";
  const isCancelling =
    isPro &&
    (subscription.cancel_at_period_end === true ||
      Boolean(subscription.cancel_at));
  const isCanceled = subscription.status === "canceled";
  const cancelDate = getEffectiveCancelDate(subscription);
  const subtitle = currentPlan.included_features.slice(0, 3).join(", ");

  return (
    <Card padding="md">
      <div className="flex flex-col gap-4">
        <PlanHeading />
        <SkillRow
          icon={
            isPro ? (
              <Crown className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <Palmtree className="h-3.5 w-3.5" aria-hidden />
            )
          }
          title={
            <span data-testid="plan-card-name">
              {isPro ? "PRO Plan" : "Basic Plan"}
            </span>
          }
          subtitle={subtitle}
          action={
            <Button
              variant={isPro ? "outlined" : "primary"}
              onClick={onManage}
              data-testid={
                isPro ? "plan-card-manage-button" : "plan-card-upgrade-button"
              }
            >
              {isPro ? "Manage" : "Upgrade to Pro"}
            </Button>
          }
        />
        {isPro && !isCancelling && !isCanceled && subscription.current_period_end && (
          <Typography
            as="p"
            variant="body-small-default"
            className="text-[var(--content-tertiary)]"
            data-testid="plan-card-renews"
          >
            Renews on {formatGraceDate(subscription.current_period_end)}.
          </Typography>
        )}
        {isPro && isCancelling && !isCanceled && cancelDate && (
          <Typography
            as="p"
            variant="body-small-default"
            className="text-[var(--system-mid-strong)]"
            data-testid="plan-card-cancels"
          >
            Your plan ends on {formatGraceDate(cancelDate)}.
          </Typography>
        )}
      </div>
    </Card>
  );
}
