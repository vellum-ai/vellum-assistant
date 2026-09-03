import { formatCostUsd } from "../../lib/cli-output.js";

export interface PlatformCreditsResult {
  remaining: number;
  settled: number;
  pending: number;
  unit: "USD";
  stale: boolean;
  as_of: string;
  daily_spend: number | null;
  daily_limit: number | null;
  daily_limit_reached: boolean;
  daily_limit_snoozed: boolean;
  low_balance_threshold: number | null;
  low_balance_warning: boolean;
  plan_credit_remaining: number | null;
  plan_credit_total: number | null;
  plan_credit_used_fraction: number | null;
  plan_credits_spent: boolean | null;
  extra_credit_remaining: number | null;
  credits_expiring_soon: number | null;
  next_credit_expiry_at: string | null;
}

/** Human-readable lines for `assistant platform credits`. */
export function formatCreditsLines(result: PlatformCreditsResult): string[] {
  const staleNote = result.stale ? " (pending data may be stale)" : "";
  const lines = [
    `Remaining: ${formatCostUsd(result.remaining)} ${result.unit} (as of ${result.as_of})${staleNote}`,
    `Settled:   ${formatCostUsd(result.settled)}   Pending: ${formatCostUsd(result.pending)}`,
  ];
  if (
    result.plan_credit_remaining !== null &&
    result.plan_credit_total !== null
  ) {
    if (result.plan_credits_spent === true) {
      // Mirrors the web usage panel: extra credit is only said to fund usage
      // once the wallet provably holds some.
      const hasExtra =
        result.extra_credit_remaining !== null &&
        result.extra_credit_remaining > 0;
      lines.push(
        hasExtra
          ? "Plan:      plan credit used up or expired; managed usage now draws on extra credit"
          : "Plan:      plan credit used up or expired, and no extra credit remains",
      );
    } else {
      const pct =
        result.plan_credit_used_fraction === null
          ? ""
          : ` (${Math.round(result.plan_credit_used_fraction * 100)}% used)`;
      lines.push(
        `Plan:      ${formatCostUsd(result.plan_credit_remaining)} of ${formatCostUsd(result.plan_credit_total)} plan credit left${pct}`,
      );
    }
  }
  if (result.extra_credit_remaining !== null) {
    lines.push(
      `Extra:     ${formatCostUsd(result.extra_credit_remaining)} bought or earned on top of plan credit`,
    );
  }
  if (
    result.credits_expiring_soon !== null &&
    result.credits_expiring_soon > 0
  ) {
    const when = result.next_credit_expiry_at
      ? ` (next expiry ${result.next_credit_expiry_at})`
      : "";
    lines.push(
      `Expiring:  ${formatCostUsd(result.credits_expiring_soon)} within 30 days${when}`,
    );
  } else if (result.next_credit_expiry_at) {
    lines.push(
      `Expiry:    next plan-credit expiry ${result.next_credit_expiry_at} (nothing expires within 30 days)`,
    );
  }
  if (result.daily_spend !== null) {
    const limit =
      result.daily_limit === null
        ? "the daily limit (none set)"
        : `the ${formatCostUsd(result.daily_limit)} daily limit`;
    const limitState = result.daily_limit_reached
      ? " (limit reached)"
      : result.daily_limit_snoozed
        ? " (limit skipped for today)"
        : "";
    // daily_spend excludes spend covered by plan-included credits, so it is
    // presented as the amount counted against the limit, never as total spend.
    lines.push(
      `Today:     ${formatCostUsd(result.daily_spend)} counted against ${limit}${limitState}`,
    );
  }
  if (result.low_balance_warning) {
    const threshold =
      result.low_balance_threshold === null
        ? ""
        : ` of ${formatCostUsd(result.low_balance_threshold)}`;
    lines.push(
      `Warning:   balance is below the low-balance threshold${threshold}`,
    );
  }
  return lines;
}
