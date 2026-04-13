/**
 * Progress ring formula — pure functions that derive
 * `progressPercent` (0-100) and `tier` (1-4) from the inputs the
 * relationship-state writer has assembled.
 *
 * The weights and targets ship as named constants so the "start simple"
 * tuning from the Phase 3 TDD can be retuned without touching the writer
 * (Open Question #5 in the TDD). Any change here should deliberately
 * break the unit tests in `progress-formula.test.ts` — those tests are
 * the contract that pins the current tuning.
 */

import type { Capability, Fact } from "./relationship-state.js";

/**
 * Weighted contributions of each signal to the raw progress score.
 * Must sum to 1 — enforced by the test suite.
 */
export const PROGRESS_WEIGHTS = {
  facts: 0.4,
  capabilities: 0.4,
  conversations: 0.2,
} as const;

/**
 * Saturation targets for each signal. Once a signal reaches its target
 * it contributes its full weight to the progress score.
 */
export const PROGRESS_TARGETS = {
  /** Saturates at 20 known facts. */
  facts: 20,
  /** Total in DEFAULT_CAPABILITIES. */
  capabilities: 6,
  /** Saturates at 20 conversations. */
  conversations: 20,
} as const;

/** Inputs to the pure progress functions. */
export interface ProgressInput {
  facts: Fact[];
  capabilities: Capability[];
  conversationCount: number;
}

/**
 * Compute the progress ring percentage (0-100).
 *
 * Pure function: no IO, no randomness. The output depends only on the
 * inputs and the named constants above.
 */
export function computeProgressPercent(input: ProgressInput): number {
  const facts = Math.min(input.facts.length / PROGRESS_TARGETS.facts, 1);
  const unlocked = input.capabilities.filter(
    (c) => c.tier === "unlocked",
  ).length;
  const caps = Math.min(unlocked / PROGRESS_TARGETS.capabilities, 1);
  const convs = Math.min(
    input.conversationCount / PROGRESS_TARGETS.conversations,
    1,
  );
  const raw =
    PROGRESS_WEIGHTS.facts * facts +
    PROGRESS_WEIGHTS.capabilities * caps +
    PROGRESS_WEIGHTS.conversations * convs;
  return Math.round(raw * 100);
}

/**
 * Compute the relationship tier (1-4).
 *
 * Tier 4 ("In sync") is reserved for a deeper heuristic later, tied to
 * autonomous actions — it is intentionally unreachable from this
 * function today so the upgrade path is observable in the test suite.
 */
export function computeTier(input: ProgressInput): 1 | 2 | 3 | 4 {
  const unlocked = input.capabilities.filter(
    (c) => c.tier === "unlocked",
  ).length;
  const convs = input.conversationCount;
  // "Hitting our stride" — real working relationship.
  if (convs >= 20 && unlocked >= 3) return 3;
  // "Finding my footing" — starting to understand how they work.
  if (convs >= 5 && input.facts.length >= 3) return 2;
  // "Getting to know you" — default for fresh relationships.
  return 1;
}
