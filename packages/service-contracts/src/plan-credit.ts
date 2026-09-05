/**
 * Plan-credit derivations shared by the assistant runtime's `platform credits`
 * route and the web client's usage meter, so both read the billing summary's
 * grant figures the same way and can never quote different readings.
 */

export type BillingPlanId = "base" | "pro";

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

/**
 * The plan-credit reading with the plan's fallback applied. The grant figures
 * count only unexpired grants, so a Pro subscription whose grants total
 * nothing has used or expired everything it was granted (a full bar, with
 * nothing scheduled to refill it), while a base plan in that position was
 * never granted anything (no reading). An unknown plan gets the ratio when
 * the figures allow one and no fallback otherwise.
 */
export function planCreditUsedFraction(
  totalUsd: number | null,
  availableUsd: number | null,
  planId: BillingPlanId | null,
): number | null {
  const ratio = usageGrantRatio(totalUsd, availableUsd);
  if (ratio != null) {
    return ratio;
  }
  if (planId === "pro" && totalUsd != null && totalUsd <= 0) {
    return 1;
  }
  return null;
}

/**
 * Credit bought or earned on top of the plan-included grants: the balance less
 * whatever is still unused on those grants, never below zero, to the cent.
 */
export function extraCreditUsd(
  balanceUsd: number,
  availableUsd: number,
): number {
  return Math.round(Math.max(0, balanceUsd - availableUsd) * 100) / 100;
}
