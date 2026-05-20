import { Loader2 } from "lucide-react";

import { useQuery } from "@tanstack/react-query";

import { Card } from "@vellum/design-library/components/card";
import { Notice } from "@vellum/design-library/components/notice";
import { Tag } from "@vellum/design-library/components/tag";
import { Typography } from "@vellum/design-library/components/typography";
import { organizationsBillingSubscriptionRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen.js";

const PLAN_DISPLAY_NAMES: Record<string, string> = { base: "Base", pro: "Pro" };

const STATUS_DISPLAY: Record<string, string> = {
  active: "Active",
  trialing: "Trialing",
  past_due: "Past due",
  canceled: "Canceled",
  incomplete: "Incomplete",
  incomplete_expired: "Incomplete",
  unpaid: "Unpaid",
  paused: "Paused",
};

/**
 * Format a renewal-date ISO timestamp using the user's locale. Matches the
 * locale-undefined approach used by `AutoTopUpStatusPanel.formatAutoTopUpAttempt`.
 */
export function formatRenewalDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(iso));
}

/**
 * Top-of-page card on the billing settings screen. Shows the org's current
 * plan name, plus (for Pro) a status badge and the next renewal date.
 *
 * The renewal-date line is suppressed when the subscription is scheduled
 * to cancel (`cancel_at_period_end`) or has already canceled — `GracePeriodBanner`
 * owns the user-facing "ends on …" copy in those states.
 */
export function CurrentPlanCard() {
  const { data, isLoading, isError } = useQuery(
    organizationsBillingSubscriptionRetrieveOptions(),
  );

  if (isLoading) {
    return (
      <Card padding="lg">
        <div className="flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          <Typography as="span" variant="body-medium-lighter">
            Loading plan…
          </Typography>
        </div>
      </Card>
    );
  }

  if (isError || !data) {
    return (
      <Notice tone="error">
        Failed to load your plan. Please try again later.
      </Notice>
    );
  }

  const planName = PLAN_DISPLAY_NAMES[data.plan_id] ?? "Unknown";
  const isPro = data.plan_id === "pro";
  // `data.status` is widened to `unknown` because heyapi types it as
  // `SubscriptionStatusEnum | NullEnum | null` and the generated `NullEnum`
  // resolves to `unknown`.
  const statusLabel =
    isPro && typeof data.status === "string"
      ? STATUS_DISPLAY[data.status] ?? null
      : null;
  // Suppress the renewal line when the subscription is scheduled to cancel
  // or already canceled — `GracePeriodBanner` owns the "ends on …" copy.
  const renewalIso =
    data.cancel_at_period_end || data.status === "canceled"
      ? null
      : data.current_period_end;

  return (
    <Card padding="lg">
      <div className="flex items-center justify-between">
        <Typography as="h2" variant="title-small">
          Current Plan
        </Typography>
        {statusLabel && <Tag data-testid="current-plan-status">{statusLabel}</Tag>}
      </div>
      <Typography
        as="p"
        variant="title-medium"
        className="mt-2"
        data-testid="current-plan-name"
      >
        {planName}
      </Typography>
      {isPro && renewalIso && (
        <Typography
          as="p"
          variant="body-medium-lighter"
          className="mt-1 text-[var(--content-tertiary)]"
          data-testid="current-plan-renewal"
        >
          Renews on {formatRenewalDate(renewalIso)}
        </Typography>
      )}
    </Card>
  );
}
