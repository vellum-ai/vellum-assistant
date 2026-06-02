/**
 * Default `toolError` behavior: decides whether to nudge the LLM after a tool
 * call fails.
 *
 * This module is side-effect free: importing it does not register any plugin.
 *
 * The canonical nudge decision: when the current turn produced at least one
 * failed tool result, append a system-notice block to the tool results that
 * coaches the LLM to either retry with corrected parameters (for recoverable
 * errors) or report the failure to the user (for unrecoverable ones). Once
 * the consecutive-error-turn counter exceeds the caller-supplied cap, the
 * nudge is skipped — the error is likely not something the LLM can fix on
 * its own and continuing to nudge only burns tokens.
 */

import type { ToolErrorArgs, ToolErrorDecision } from "../../types.js";

/**
 * Canonical nudge text. Kept as a module-level constant so tests and future
 * plugins can match it without duplicating the string.
 */
export const DEFAULT_TOOL_ERROR_NUDGE_TEXT =
  "<system_notice>One or more tool calls returned an error. If the error looks recoverable (e.g. missing or invalid parameters), fix the parameters and retry. If the error is clearly unrecoverable (e.g. a service is down, a resource does not exist, or a permission is permanently denied), report it to the user.</system_notice>";

/**
 * Nudge iff the current turn had an error AND the consecutive-error counter is
 * within the cap. Once the cap is breached the caller should stop appending
 * the nudge (the error is likely unrecoverable and the LLM already had
 * multiple attempts to correct it).
 *
 * Exported so the agent loop can call it directly and tests can verify the
 * decision logic.
 */
export const defaultToolErrorTerminal = async (
  args: ToolErrorArgs,
): Promise<ToolErrorDecision> => {
  if (
    args.hasToolError &&
    args.consecutiveErrorTurns <= args.maxConsecutiveErrorNudges
  ) {
    return {
      action: "nudge",
      nudgeText: DEFAULT_TOOL_ERROR_NUDGE_TEXT,
    };
  }
  return { action: "skip" };
};
