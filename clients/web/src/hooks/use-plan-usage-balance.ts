/**
 * The Usage Balance reading behind the `obscure-credits` flag, in two shapes.
 *
 * A Pro sub is measured over its billing cycle: spend so far this cycle
 * against the monthly credits the subscription includes, resetting when the
 * cycle turns over. A base (free) plan has no cycle and no included bundle, so
 * it is measured over its usage grants instead: how much of the credit it was
 * granted (the initial credit, net of refunds) is already used. That reading
 * comes straight off the billing summary the caller already holds, so it costs
 * no usage read at all, and nothing about it resets.
 *
 * Read by the billing Plan tile and by the chat sidebar's preferences menu, so
 * it lives here rather than in either domain.
 */

import { useQuery } from "@tanstack/react-query";

import { organizationsBillingUsageTotalsRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import type {
  PlanListResponse,
  ProPackage,
  ProPlan,
  SubscriptionResponse,
} from "@/generated/api/types.gen";
import { creditTierKeyUsd, findCreditTier } from "@/lib/billing/credit-tiers";
import { useObscureCredits } from "@/hooks/use-obscure-credits-flag";

export interface PlanUsageBalance {
  /**
   * Which denominator the ratio is measured against: `cycle` for a Pro sub's
   * monthly included bundle, `wallet` for a free plan's usage grants.
   */
  kind: "cycle" | "wallet";
  /** Spend against that denominator, clamped to 0..1. */
  ratio: number;
  /**
   * The cycle end the bar resets on, as the subscription reports it, or null
   * for a wallet reading, which never resets.
   */
  resetsAt: string | null;
}

interface PlanUsageBalanceArgs {
  subscription: SubscriptionResponse | undefined;
  /** Monthly included credits in USD, or null when no bar should be drawn. */
  includedCreditsUsd: number | null;
  /**
   * Unused credit left on the usage grants and what those grants were worth
   * to begin with, exactly as `useBillingBalanceStatus()` reports them. Both
   * callers already hold that hook, so the summary is threaded in rather than
   * read a second time here. Either one absent, a free plan has no reading and
   * draws no bar, which is also what an older platform that reports neither
   * field gets.
   */
  availableUsageBalance?: string | null;
  totalUsageBalance?: string | null;
}

/**
 * What a Pro sub's own credit tier is worth per month: the catalog's amount,
 * or the amount encoded in the tier key when the catalog has dropped a
 * grandfathered tier. Mirrors how `currentTierRows` prices the same tier.
 */
function creditTierUsd(
  tier: string | null | undefined,
  proPlan: ProPlan | null | undefined,
): number | null {
  return (
    findCreditTier(proPlan ?? undefined, tier)?.credits_usd ??
    creditTierKeyUsd(tier)
  );
}

/**
 * The monthly credits a Pro subscription includes, or null when no honest
 * denominator exists and the bar must not render.
 *
 * A clean pin states its bundle on the stock package. A customized or unpinned
 * (Custom) sub matches no package, so it is priced from the credit tier it
 * actually holds. Anything that resolves to nothing, or to a non-positive
 * amount, has no bar to draw rather than one divided by zero.
 */
export function includedMonthlyCreditsUsd(
  subscription: SubscriptionResponse | undefined,
  currentPackage: ProPackage | null,
  proPlan: ProPlan | null | undefined,
): number | null {
  if (subscription?.plan_id !== "pro") {
    return null;
  }
  const usd =
    currentPackage?.credits_usd ??
    creditTierUsd(subscription.selected_credit_tier, proPlan);
  return typeof usd === "number" && usd > 0 ? usd : null;
}

/**
 * The same denominator resolved straight from the plan catalog, for callers
 * that hold the raw queries rather than an already-resolved package: the stock
 * package a clean pin names, and nothing for a customized or unpinned sub,
 * which {@link includedMonthlyCreditsUsd} prices from its credit tier instead.
 */
export function includedMonthlyCreditsUsdFromPlans(
  subscription: SubscriptionResponse | undefined,
  plans: PlanListResponse["plans"] | undefined,
): number | null {
  const proPlan = plans?.find((p): p is ProPlan => p.id === "pro") ?? null;
  const pin = subscription?.package;
  const pinned =
    pin != null && !pin.customized
      ? (proPlan?.packages?.find(
          (p) => p.key === pin.key && p.version === pin.version,
        ) ?? null)
      : null;
  return includedMonthlyCreditsUsd(subscription, pinned, proPlan);
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

/** A decimal-string amount as a number, or null when there is none to read. */
function parseUsd(value: string | null | undefined): number | null {
  if (value == null) {
    return null;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * How much of the usage credit an account was granted it has already used:
 * the granted total less what is still unused, over that total. The initial
 * $5 grant burns 0 to 100% as it is spent, and a further grant grows the total
 * so the bar drops back. Null when nothing was ever granted, or when the
 * platform reports neither figure, which has no honest reading rather than a
 * full or empty bar.
 */
export function usageGrantRatio(
  totalUsd: number | null,
  availableUsd: number | null,
): number | null {
  if (totalUsd == null || availableUsd == null || totalUsd <= 0) {
    return null;
  }
  return clamp01((totalUsd - availableUsd) / totalUsd);
}

export function usePlanUsageBalance(
  args: PlanUsageBalanceArgs,
): PlanUsageBalance | null {
  const {
    subscription,
    includedCreditsUsd: credits,
    availableUsageBalance = null,
    totalUsageBalance = null,
  } = args;
  const obscureCredits = useObscureCredits();

  const isBasePlan = subscription?.plan_id === "base";
  const periodEnd = subscription?.current_period_end ?? null;
  // A platform that predates `current_period_start` simply omits it, so an
  // absent value derives the cycle start from the end instead of failing.
  const reportedStart = subscription?.current_period_start;
  const cycleFrom = reportedStart
    ? utcDate(reportedStart)
    : periodEnd
      ? utcMonthBefore(periodEnd)
      : null;

  const cycleEnabled =
    obscureCredits &&
    subscription?.plan_id === "pro" &&
    credits != null &&
    credits > 0 &&
    periodEnd != null &&
    cycleFrom != null;

  const totalsQuery = useQuery({
    ...organizationsBillingUsageTotalsRetrieveOptions({
      query: {
        from: cycleFrom ?? "",
        to: new Date().toISOString().slice(0, 10),
      },
    }),
    enabled: cycleEnabled,
  });

  // A free plan reads entirely off the billing summary the caller already
  // holds, so it never asks the usage endpoint for a window at all.
  if (obscureCredits && isBasePlan) {
    const ratio = usageGrantRatio(
      parseUsd(totalUsageBalance),
      parseUsd(availableUsageBalance),
    );
    return ratio == null ? null : { kind: "wallet", ratio, resetsAt: null };
  }

  if (!cycleEnabled || credits == null || periodEnd == null) {
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
  return {
    kind: "cycle",
    ratio: clamp01(spent / credits),
    resetsAt: periodEnd,
  };
}
