/**
 * The Usage Balance reading behind the `obscure-credits` flag.
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
import { useObscureCredits } from "@/hooks/use-obscure-credits-flag";
import { parseUsd } from "@/lib/billing/parse-usd";

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

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value > 1 ? 1 : value;
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
    availableUsageBalance = null,
    totalUsageBalance = null,
  } = args;
  const obscureCredits = useObscureCredits();

  if (!obscureCredits) {
    return null;
  }

  const total = parseUsd(totalUsageBalance);
  const ratio = usageGrantRatio(total, parseUsd(availableUsageBalance));

  if (subscription?.plan_id === "base") {
    // Nothing granted is not a reading; the tile keeps its price row.
    return ratio == null ? null : { ratio };
  }
  if (subscription?.plan_id !== "pro") {
    return null;
  }
  if (ratio != null) {
    return { ratio };
  }
  // A Pro sub always held a grant at some point (the initial credit, or the
  // bundle a paid cycle issued), so a zero total means everything it was
  // granted is used or expired: a fully spent bar, with nothing scheduled to
  // refill it.
  if (total != null && total <= 0) {
    return { ratio: 1 };
  }
  // The platform reports no usable grant figures, so no honest reading exists.
  return null;
}
