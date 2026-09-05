/**
 * The Usage Balance reading.
 *
 * Every plan reads straight off the billing summary's usage-grant figures:
 * how much of the credit the org was granted (initial credit and Pro bundle
 * grants, net of refunds) is already used. Both callers already hold that
 * summary through `useBillingBalanceStatus()`, so the reading costs no usage
 * read at all. The aggregate mixes grants with different lifetimes (only the
 * bundle turns over with the billing cycle), so no single date honestly says
 * when the bar resets, and the reading quotes none.
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
import { parseUsd } from "@/lib/billing/parse-usd";
import {
  planCreditUsedFraction,
  usageGrantRatio,
} from "@vellumai/service-contracts/plan-credit";

export { usageGrantRatio };

export interface PlanUsageBalance {
  /** Used share of the granted usage credit, clamped to 0..1. */
  ratio: number;
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
