/**
 * Default `toolError` plugin.
 *
 * The plugin's middleware is a passthrough — it calls `next(args)` and returns
 * the result unchanged. The actual nudge-decision logic lives in
 * {@link defaultToolErrorTerminal}, which is wired in as the pipeline's
 * `terminal` argument by the `runPipeline` call site in `agent/loop.ts`. This
 * separation matters: the default plugin is registered before any user plugin
 * (defaults load first via module-side-effect imports / `registerDefaultPlugins`),
 * which puts it at the OUTERMOST position of the onion chain. If the default
 * middleware invoked the decision logic directly without calling `next`, it
 * would shadow every later-registered plugin. Routing through `next(args)`
 * lets user middleware participate normally.
 *
 * The canonical nudge decision: when the current turn produced at least one
 * failed tool result, append a system-notice block to the tool results that
 * coaches the LLM to either retry with corrected parameters (for recoverable
 * errors) or report the failure to the user (for unrecoverable ones). Once
 * the consecutive-error-turn counter exceeds the caller-supplied cap, the
 * nudge is skipped — the error is likely not something the LLM can fix on
 * its own and continuing to nudge only burns tokens.
 *
 * Design doc: `.private/plans/agent-plugin-system.md` (PR 19).
 */

import { registerPlugin } from "../registry.js";
import {
  type Middleware,
  type Plugin,
  PluginExecutionError,
  type ToolErrorArgs,
  type ToolErrorDecision,
} from "../types.js";

/**
 * Canonical nudge text. Kept as a module-level constant so tests and future
 * plugins can match it without duplicating the string.
 */
export const DEFAULT_TOOL_ERROR_NUDGE_TEXT =
  "<system_notice>One or more tool calls returned an error. If the error looks recoverable (e.g. missing or invalid parameters), fix the parameters and retry. If the error is clearly unrecoverable (e.g. a service is down, a resource does not exist, or a permission is permanently denied), report it to the user.</system_notice>";

/**
 * Terminal handler for the `toolError` pipeline. Nudge iff the current turn
 * had an error AND the consecutive-error counter is within the cap. Once the
 * cap is breached the caller should stop appending the nudge (the error is
 * likely unrecoverable and the LLM already had multiple attempts to correct
 * it).
 *
 * Exported so `agent/loop.ts` can pass it as the `terminal` argument to
 * `runPipeline` (ensuring the nudge decision fires even when no plugin is
 * registered — e.g. direct AgentLoop callers that skip `bootstrapPlugins()`)
 * and so tests can verify the decision logic directly without going through
 * the pipeline runner.
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
 * Default middleware for the `toolError` slot. Passthrough — calls `next(args)`
 * so later-registered user plugins still participate in the onion chain. The
 * actual decision logic lives in {@link defaultToolErrorTerminal}, wired in
 * at the `runPipeline` call site in `agent/loop.ts`.
 *
 * Named explicitly so the pipeline's structured log record carries
 * `"defaultToolErrorMiddleware"` in `chain` instead of an anonymous entry.
 */
const defaultToolErrorMiddleware: Middleware<ToolErrorArgs, ToolErrorDecision> =
  async function defaultToolErrorMiddleware(args, next) {
    return next(args);
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

// Module-load side effect: register this default at import time so
// downstream consumers (including tests that skip `bootstrapPlugins()`)
// observe a populated registry by default. Idempotent via the swallowed
// duplicate-name check. Kept local to this module (rather than iterating
// an array in `defaults/index.ts`) so the registration only references
// the already-initialized `defaultToolErrorPlugin` identifier —
// avoiding a TDZ crash when tests `mock.module(...)` a dependency of any
// other default plugin and directly import this file.
try {
  registerPlugin(defaultToolErrorPlugin);
} catch (err) {
  if (
    err instanceof PluginExecutionError &&
    err.message.includes("already registered")
  ) {
    // already registered — expected when both index.ts and the direct
    // file are imported in the same process
  } else {
    throw err;
  }
}
