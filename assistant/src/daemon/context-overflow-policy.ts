import type { ContextOverflowRecoveryConfig } from "../config/schemas/inference.js";

/**
 * Actions the overflow recovery loop can take when the context window is
 * exceeded and standard compaction has already been applied.
 */
export type OverflowAction =
  | "auto_compress_latest_turn"
  | "request_user_approval"
  | "fail_gracefully";

export interface OverflowPolicyInput {
  overflowRecovery: ContextOverflowRecoveryConfig;
  isInteractive: boolean;
}

/**
 * Deterministic policy resolver that maps config knobs + session interactivity
 * to a concrete overflow action.
 *
 * The recovery pipeline calls this after standard compaction is exhausted.
 * Interactive sessions default to asking the user before compressing the
 * latest turn; non-interactive sessions auto-compress.
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

  // For non-interactive sessions, compress without asking.
  if (!isInteractive) {
    return "auto_compress_latest_turn";
  }

  // Interactive sessions ask for approval before compressing.
  return "request_user_approval";
}
