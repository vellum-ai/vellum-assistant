import type { ContextOverflowRecoveryConfig } from "../config/schemas/inference.js";

/**
 * Actions the overflow recovery loop can take when the context window is
 * exceeded and standard compaction has already been applied.
 */
export type OverflowAction = "auto_compress_latest_turn" | "fail_gracefully";

export interface OverflowPolicyInput {
  overflowRecovery: ContextOverflowRecoveryConfig;
  isInteractive: boolean;
}

/**
 * Deterministic policy resolver that maps config knobs + conversation interactivity
 * to a concrete overflow action.
 *
 * The recovery pipeline calls this after standard compaction is exhausted.
 * All conversations auto-compress the latest turn when standard compaction is
 * exhausted, unless the policy is `drop` (opt-out) or recovery is disabled.
 */
export function resolveOverflowAction(
  input: OverflowPolicyInput,
): OverflowAction {
  const { overflowRecovery, isInteractive } = input;

  if (!overflowRecovery.enabled) {
    return "fail_gracefully";
  }

  const policy = isInteractive
    ? overflowRecovery.interactiveLatestTurnCompression
    : overflowRecovery.nonInteractiveLatestTurnCompression;

  // "drop" means the user has opted out of latest-turn compression entirely.
  if (policy === "drop") {
    return "fail_gracefully";
  }

  return "auto_compress_latest_turn";
}
