/**
 * The Plan section's Usage Balance reading, behind the `obscure-credits` flag:
 * managed usage spend so far this billing cycle measured against the package's
 * included credits.
 */

import { useQuery } from "@tanstack/react-query";

import type { ProPackage } from "@/domains/settings/billing/package-types";
import { organizationsBillingUsageTotalsRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import type { SubscriptionResponse } from "@/generated/api/types.gen";
import { useObscureCredits } from "@/hooks/use-obscure-credits-flag";

export interface PlanUsageBalance {
  /** Spend against the included bundle, clamped to 0..1. */
  ratio: number;
  /** The cycle end the bar resets on, as the subscription reports it. */
  resetsAt: string;
}

interface PlanUsageBalanceArgs {
  subscription: SubscriptionResponse | undefined;
  currentPackage: ProPackage | null;
}

/** UTC calendar date (YYYY-MM-DD), the form the usage endpoint's range takes. */
function utcDate(iso: string): string | null {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime())
    ? null
    : parsed.toISOString().slice(0, 10);
}

/**
 * One calendar month before `iso`, clamping a day the earlier month does not
 * have (Mar 31 minus one month is the last day of February). Stands in for
 * `current_period_start` on platforms that do not report it yet.
 */
export function utcMonthBefore(iso: string): string | null {
  const end = new Date(iso);
  if (Number.isNaN(end.getTime())) {
    return null;
  }
  const year = end.getUTCFullYear();
  const month = end.getUTCMonth();
  // Day 0 of the current month is the last day of the previous one, which is
  // the clamp for a day that month is too short to hold.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = Math.min(end.getUTCDate(), lastDay);
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value > 1 ? 1 : value;
}

export function usePlanUsageBalance(
  args: PlanUsageBalanceArgs,
): PlanUsageBalance | null {
  const { subscription, currentPackage } = args;
  const obscureCredits = useObscureCredits();

  const included = currentPackage?.credits_usd;
  const credits =
    typeof included === "number" && included > 0 ? included : null;
  const periodEnd = subscription?.current_period_end ?? null;
  // A platform that predates `current_period_start` simply omits it, so an
  // absent value derives the cycle start from the end instead of failing.
  const reportedStart = subscription?.current_period_start;
  const from = reportedStart
    ? utcDate(reportedStart)
    : periodEnd
      ? utcMonthBefore(periodEnd)
      : null;

  const enabled =
    obscureCredits &&
    subscription?.plan_id === "pro" &&
    credits != null &&
    periodEnd != null &&
    from != null;

  const totalsQuery = useQuery({
    ...organizationsBillingUsageTotalsRetrieveOptions({
      query: { from: from ?? "", to: new Date().toISOString().slice(0, 10) },
    }),
    enabled,
  });

  if (!enabled || credits == null || periodEnd == null) {
    return null;
  }
  // A loading or failed read has no honest number to show, so the panel is
  // omitted rather than drawn at zero.
  const total = totalsQuery.data?.total_usd;
  if (total == null) {
    return null;
  }
  const spent = Number.parseFloat(total);
  if (!Number.isFinite(spent)) {
    return null;
  }
  return { ratio: clamp01(spent / credits), resetsAt: periodEnd };
}
