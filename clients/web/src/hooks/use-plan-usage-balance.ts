/**
 * The usage reading behind the Plan tile's Current Usage panel and the
 * preferences menu's Usage panel.
 *
 * Every plan reads straight off the billing summary's usage-grant figures:
 * how much of the credit the org was granted (initial credit and Pro bundle
 * grants, net of refunds) is already used. Both callers already hold that
 * summary through `useBillingBalanceStatus()`, so the reading costs no usage
 * read at all. The Plan tile dates the cycle end beside this reading; see
 * `UsagePeriodEnd` for its wording.
 *
 * The two figures count only unexpired grants. A Pro sub whose grants total
 * nothing (every grant expired, or a plan that never carried one) has spent
 * everything its plan gave it, which is a full bar rather than a missing one:
 * whatever credit the org still holds lives in the wallet, which the
 * add-credits strip reads separately. A free plan in the same position was
 * simply never granted anything, so it has no reading and its tile keeps its
 * price row.
 *
 * Read by the billing Plan tile and by the chat sidebar's preferences menu, so
 * it lives here rather than in either domain.
 */

import type { SubscriptionResponse } from "@/generated/api/types.gen";
import type { BillingBalanceStatus } from "@/hooks/use-billing-balance-status";
import { parseUsd } from "@/lib/billing/parse-usd";
import {
  extraCreditUsd,
  planCreditUsedFraction,
  usageGrantRatio,
} from "@vellumai/service-contracts/plan-credit";

export { usageGrantRatio };

export interface PlanUsageBalance {
  /** Used share of the granted usage credit, clamped to 0..1. */
  ratio: number;
}

/**
 * The free-tier daily bar's reading: today's usage-credit spend over the
 * per-day cap, clamped to 0..1. Null when either figure is missing or the cap
 * is not positive. Once the overall usage grant is spent (`overallRatio` at
 * 1) the day reads as fully used too, whatever the counter says: there is no
 * usage credit left for today to draw on, and two bars that disagree about
 * that would only confuse.
 */
export function freeTierDailyUsedFraction(
  dailySpendUsd: number | null,
  dailyLimitUsd: number | null,
  overallRatio: number | null,
): number | null {
  if (overallRatio != null && overallRatio >= 1) {
    return 1;
  }
  if (dailySpendUsd == null || dailyLimitUsd == null || dailyLimitUsd <= 0) {
    return null;
  }
  const ratio = dailySpendUsd / dailyLimitUsd;
  if (!Number.isFinite(ratio) || ratio < 0) {
    return 0;
  }
  return ratio > 1 ? 1 : ratio;
}

/**
 * The free-tier daily reading straight off the wallet status: null unless the
 * platform is enforcing the cap on this org. See
 * {@link freeTierDailyUsedFraction} for the reading itself.
 */
export function freeTierDailyRatio(
  status: Pick<
    BillingBalanceStatus,
    "freeTierDailyLimitEnforced" | "freeTierDailyLimit" | "freeTierDailySpend"
  >,
  overallRatio: number | null,
): number | null {
  if (!status.freeTierDailyLimitEnforced) {
    return null;
  }
  return freeTierDailyUsedFraction(
    parseUsd(status.freeTierDailySpend),
    parseUsd(status.freeTierDailyLimit),
    overallRatio,
  );
}

/**
 * Dollars of today's free-tier allowance still unspent, or null outside the
 * cohort. Zero once the overall grant is spent, whatever the counter says:
 * there is no usage credit left for today to draw on.
 */
export function freeTierDailyLeftUsd(
  status: Pick<
    BillingBalanceStatus,
    "freeTierDailyLimitEnforced" | "freeTierDailyLimit" | "freeTierDailySpend"
  >,
  overallRatio: number | null,
): number | null {
  if (!status.freeTierDailyLimitEnforced) {
    return null;
  }
  if (overallRatio != null && overallRatio >= 1) {
    return 0;
  }
  const limit = parseUsd(status.freeTierDailyLimit);
  const spend = parseUsd(status.freeTierDailySpend);
  if (limit == null || spend == null) {
    return null;
  }
  return Math.max(0, limit - spend);
}

/**
 * Whether the wallet holds credit bought or earned on top of the usage
 * grants. Under the free-tier cap that is the only credit that spends today:
 * the grants' own remainder is frozen until the UTC reset, so a wallet holding
 * nothing but that remainder has nothing to draw on and the platform rejects
 * the next send. A null balance is unknown, not extra credit.
 */
export function hasExtraCredit(
  status: Pick<BillingBalanceStatus, "balance" | "availableUsageBalance">,
): boolean {
  const balance = parseUsd(status.balance);
  if (balance == null) {
    return false;
  }
  return (
    extraCreditUsd(balance, parseUsd(status.availableUsageBalance) ?? 0) > 0
  );
}

interface PlanUsageBalanceArgs {
  subscription: SubscriptionResponse | undefined;
  /**
   * Unused credit left on the usage grants and what those grants were worth
   * to begin with, exactly as `useBillingBalanceStatus()` reports them. Both
   * callers already hold that hook, so the summary is threaded in rather than
   * read a second time here. An older platform reports neither field, which
   * has no honest reading and draws no bar.
   */
  availableUsageBalance?: string | null;
  totalUsageBalance?: string | null;
}

export function usePlanUsageBalance(
  args: PlanUsageBalanceArgs,
): PlanUsageBalance | null {
  const {
    subscription,
    availableUsageBalance = null,
    totalUsageBalance = null,
  } = args;

  const planId = subscription?.plan_id;
  if (planId !== "base" && planId !== "pro") {
    // Which fallback applies depends on the plan, so the reading waits for
    // the subscription rather than guessing.
    return null;
  }
  const ratio = planCreditUsedFraction(
    parseUsd(totalUsageBalance),
    parseUsd(availableUsageBalance),
    planId,
  );
  return ratio == null ? null : { ratio };
}
