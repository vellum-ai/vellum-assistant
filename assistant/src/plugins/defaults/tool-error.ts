/**
 * Default `toolError` pipeline plugin.
 *
 * Replicates the inline tool-error-nudge logic that previously lived in
 * `agent/loop.ts`: when the current turn produced at least one failed tool
 * result, append a system-notice block to the tool results that coaches the
 * LLM to either retry with corrected parameters (for recoverable errors) or
 * report the failure to the user (for unrecoverable ones). After the
 * consecutive-error-turn counter exceeds the cap the caller supplies, this
 * default stops nudging — the error is likely not something the LLM can fix
 * on its own and continuing to nudge only burns tokens.
 *
 * Design doc: `.private/plans/agent-plugin-system.md` (PR 19).
 */

import type {
  Middleware,
  Plugin,
  ToolErrorArgs,
  ToolErrorDecision,
} from "../types.js";

/**
 * Canonical nudge text. Kept as a module-level constant so tests and future
 * plugins can match it without duplicating the string.
 */
export const DEFAULT_TOOL_ERROR_NUDGE_TEXT =
  "<system_notice>One or more tool calls returned an error. If the error looks recoverable (e.g. missing or invalid parameters), fix the parameters and retry. If the error is clearly unrecoverable (e.g. a service is down, a resource does not exist, or a permission is permanently denied), report it to the user.</system_notice>";

/**
 * Terminal handler for the `toolError` pipeline. Mirrors the pre-plugin
 * behavior: nudge iff the current turn had an error AND the consecutive-error
 * counter is within the cap. Once the cap is breached the caller should stop
 * appending the nudge (the error is likely unrecoverable and the LLM already
 * had multiple attempts to correct it).
 *
 * Exported so callers (and tests) can reuse the decision logic directly
 * without going through the pipeline runner.
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

/**
 * Default middleware for the `toolError` slot. Acts as the terminal — it
 * returns a decision directly instead of calling `next`, so the pre-plugin
 * behavior fires even when no user plugin contributes its own middleware.
 *
 * Named explicitly so the pipeline's structured log record carries
 * `"defaultToolErrorMiddleware"` in `chain` instead of an anonymous entry.
 */
const defaultToolErrorMiddleware: Middleware<ToolErrorArgs, ToolErrorDecision> =
  async function defaultToolErrorMiddleware(args, _next) {
    return defaultToolErrorTerminal(args);
  };

/**
 * Plugin registration for the default `toolError` behavior. Registered by
 * `daemon/external-plugins-bootstrap.ts` via a side-effect import so the
 * middleware is available to the pipeline runner from daemon startup.
 */
export const defaultToolErrorPlugin: Plugin = {
  manifest: {
    name: "default-tool-error",
    version: "1.0.0",
    requires: {
      pluginRuntime: "v1",
      toolErrorApi: "v1",
    },
    provides: {
      toolError: "v1",
    },
  },
  middleware: {
    toolError: defaultToolErrorMiddleware,
  },
};
