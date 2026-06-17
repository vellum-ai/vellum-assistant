import { Crown, FileText, Loader2, Palmtree, type LucideIcon } from "lucide-react";

import { useState } from "react";

import { useQuery } from "@tanstack/react-query";

import {
    formatGraceDate,
    getEffectiveCancelDate,
} from "@/domains/settings/hooks/use-billing-portal-session";
import {
    organizationsBillingPlansRetrieveOptions,
    organizationsBillingSubscriptionRetrieveOptions,
} from "@/generated/api/@tanstack/react-query.gen";
import type { ProPlan } from "@/generated/api/types.gen";
import type { ButtonProps } from "@vellumai/design-library/components/button";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { Notice } from "@vellumai/design-library/components/notice";
import { Typography } from "@vellumai/design-library/components/typography";
import { InvoicesModal } from "./invoices-modal";
import { PlanFeatureList } from "./plan-feature-list";
import { formatMonthly } from "./tier-pricing";

interface PlanDisplay {
  icon: LucideIcon;
  actionLabel: string;
  actionVariant: ButtonProps["variant"];
  actionTestId: string;
  showsRenewal: boolean;
}

const PLAN_DISPLAY: Record<string, PlanDisplay> = {
  pro: {
    icon: Crown,
    actionLabel: "Manage",
    actionVariant: "outlined",
    actionTestId: "plan-card-manage-button",
    showsRenewal: true,
  },
  base: {
    icon: Palmtree,
    actionLabel: "Upgrade to Pro",
    actionVariant: "primary",
    actionTestId: "plan-card-upgrade-button",
    showsRenewal: false,
  },
};

const DEFAULT_DISPLAY: PlanDisplay = PLAN_DISPLAY.base;

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
        Manage which Vellum plan you&apos;re on.
      </Typography>
    </div>
  );
}

export function PlanCard({ onManage }: PlanCardProps) {
  const [invoicesOpen, setInvoicesOpen] = useState(false);
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

  const display = PLAN_DISPLAY[currentPlan.id] ?? DEFAULT_DISPLAY;
  const PlanIcon = display.icon;
  const planName = currentPlan.name ?? currentPlan.id;

  const isCancelling =
    display.showsRenewal &&
    (subscription.cancel_at_period_end === true ||
      Boolean(subscription.cancel_at));
  const isCanceled = subscription.status === "canceled";
  const cancelDate = getEffectiveCancelDate(subscription);
  const showRenewal = display.showsRenewal && !isCancelling && !isCanceled && subscription.current_period_end;
  const showCancellation = display.showsRenewal && isCancelling && !isCanceled && cancelDate;

  // Catalog-gated current credit bundle, shown only for a Pro org with a
  // non-null selected tier when the catalog advertises `credit_tiers`. Resolve
  // the label/price from the catalog, falling back to the raw tier key. A null
  // selection (no bundle / $0) renders nothing.
  const proPlan = currentPlan.id === "pro" ? (currentPlan as ProPlan) : undefined;
  const selectedCreditTier = subscription.selected_credit_tier ?? null;
  const creditTiers =
    selectedCreditTier != null ? proPlan?.credit_tiers : undefined;
  const creditTier = creditTiers?.find((t) => t.tier === selectedCreditTier);
  const creditBundleLabel = creditTier
    ? `${creditTier.label} (${formatMonthly(creditTier.price_cents)})`
    : creditTiers?.length
      ? selectedCreditTier
      : null;

  return (
    <Card padding="lg">
      <div className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-3">
          <PlanHeading />
          <Button
            variant="outlined"
            leftIcon={<FileText />}
            onClick={() => setInvoicesOpen(true)}
            data-testid="plan-card-invoices-button"
          >
            Invoices
          </Button>
        </div>
        <div className="flex items-center gap-3 rounded-lg bg-[var(--surface-base)] p-3">
          <span
            aria-hidden
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--border-base)] bg-[var(--surface-overlay)]"
          >
            <PlanIcon className="h-4 w-4 text-[var(--content-default)]" />
          </span>
          <div className="min-w-0 flex-1 space-y-0.5">
            <Typography variant="body-medium-default" as="div" data-testid="plan-card-name">
              {planName}
            </Typography>
            <Typography variant="body-small-default" as="div" className="leading-snug text-[var(--content-tertiary)]">
              <PlanFeatureList features={currentPlan.included_features} variant="inline" />
            </Typography>
          </div>
          <Button
            variant={display.actionVariant}
            onClick={onManage}
            data-testid={display.actionTestId}
          >
            {display.actionLabel}
          </Button>
        </div>
        {creditBundleLabel && (
          <Typography
            as="p"
            variant="body-small-default"
            className="text-[var(--content-tertiary)]"
            data-testid="plan-card-credit-bundle"
          >
            Monthly credits: {creditBundleLabel}
          </Typography>
        )}
        {showRenewal && (
          <Typography
            as="p"
            variant="body-small-default"
            className="text-[var(--content-tertiary)]"
            data-testid="plan-card-renews"
          >
            Renews on {formatGraceDate(subscription.current_period_end!)}.
          </Typography>
        )}
        {showCancellation && (
          <Typography
            as="p"
            variant="body-small-default"
            className="text-[var(--system-mid-strong)]"
            data-testid="plan-card-cancels"
          >
            Your plan ends on {formatGraceDate(cancelDate!)}.
          </Typography>
        )}
      </div>
      <InvoicesModal open={invoicesOpen} onOpenChange={setInvoicesOpen} />
    </Card>
  );
}
