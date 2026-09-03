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
}

/** Human-readable lines for `assistant platform credits`. */
export function formatCreditsLines(result: PlatformCreditsResult): string[] {
  const staleNote = result.stale ? " (pending data may be stale)" : "";
  const lines = [
    `Remaining: ${formatCostUsd(result.remaining)} ${result.unit} (as of ${result.as_of})${staleNote}`,
    `Settled:   ${formatCostUsd(result.settled)}   Pending: ${formatCostUsd(result.pending)}`,
  ];
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
