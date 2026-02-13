import type { BudgetRule, CostControlsConfig } from '../config/types.js';
import { getUsageSummary } from './summary.js';

export type { BudgetRule };

export interface BudgetViolation {
  period: BudgetRule['period'];
  amountUsd: number;
  currentSpend: number;
  action: BudgetRule['action'];
  exceeded: boolean;
}

export interface BudgetEvaluation {
  violations: BudgetViolation[];
  hasWarnings: boolean;
  hasBlocks: boolean;
}

const PERIOD_DURATIONS_MS: Record<BudgetRule['period'], number> = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
};

/**
 * Evaluate configured budget rules against current usage data.
 *
 * For each budget rule the function computes the appropriate time window
 * (day = last 24h, week = last 7d, month = last 30d), queries usage via
 * `getUsageSummary`, and compares `totalPricedCostUsd` against the budget
 * threshold.
 *
 * @param config - The costControls config section
 * @param now    - Optional epoch-ms timestamp to use as "now" (defaults to Date.now())
 */
export function evaluateBudgets(
  config: CostControlsConfig,
  now?: number,
): BudgetEvaluation {
  const currentTime = now ?? Date.now();
  const violations: BudgetViolation[] = [];

  if (!config.enabled) {
    return { violations, hasWarnings: false, hasBlocks: false };
  }

  for (const rule of config.budgets) {
    const windowMs = PERIOD_DURATIONS_MS[rule.period];
    const startAt = currentTime - windowMs;
    const endAt = currentTime;

    const summary = getUsageSummary({ startAt, endAt });
    const currentSpend = summary.totalPricedCostUsd;
    const exceeded = currentSpend >= rule.amountUsd;

    violations.push({
      period: rule.period,
      amountUsd: rule.amountUsd,
      currentSpend,
      action: rule.action,
      exceeded,
    });
  }

  return {
    violations,
    hasWarnings: violations.some((v) => v.exceeded && v.action === 'warn'),
    hasBlocks: violations.some((v) => v.exceeded && v.action === 'block'),
  };
}
