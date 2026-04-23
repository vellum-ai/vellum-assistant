/**
 * Default `historyRepair` plugin.
 *
 * The plugin's middleware is a passthrough — it calls `next(args)` and returns
 * the result unchanged. The actual repair lives in
 * {@link defaultHistoryRepairTerminal}, which is wired in as the pipeline's
 * `terminal` argument by `runPipeline` call sites in
 * `daemon/conversation-agent-loop.ts`. This separation matters: the default
 * plugin is registered before any user plugin (defaults load first in
 * `bootstrapPlugins()`), which puts it at the OUTERMOST position of the onion
 * chain. If the default middleware were to invoke the terminal directly
 * without calling `next`, it would shadow every later-registered plugin.
 * Routing through `next(args)` lets user middleware participate normally.
 *
 * Plugins that override this middleware receive both `history` and `provider`
 * so they can route behavior per provider (e.g. strip blocks a specific
 * provider can't handle) without reaching into ambient state.
 *
 * Scope: this pipeline wraps only the standard pre-run repair (`repairHistory`).
 * The orchestrator's one-shot deep-repair fallback (`deepRepairHistory`),
 * invoked only after a provider ordering error, intentionally bypasses the
 * pipeline today — see the design note at the `deepRepairHistory` call site
 * in `daemon/conversation-agent-loop.ts`.
 */

import { repairHistory } from "../../daemon/history-repair.js";
import { registerPlugin } from "../registry.js";
import {
  type HistoryRepairArgs,
  type HistoryRepairResult,
  type Middleware,
  type Plugin,
  PluginExecutionError,
} from "../types.js";

/**
 * Terminal handler for the `historyRepair` pipeline. Exported so tests can
 * verify default behavior directly without going through `runPipeline`, and
 * so `daemon/conversation-agent-loop.ts` can pass it as the `terminal`
 * argument to `runPipeline`.
 */
export function defaultHistoryRepairTerminal(
  args: HistoryRepairArgs,
): HistoryRepairResult {
  return repairHistory(args.history);
}

const passthrough: Middleware<HistoryRepairArgs, HistoryRepairResult> = async (
  args,
  next,
) => next(args);

export const defaultHistoryRepairPlugin: Plugin = {
  manifest: {
    name: "default-history-repair",
    version: "1.0.0",
    provides: { historyRepair: "v1" },
    requires: { pluginRuntime: "v1", historyRepairApi: "v1" },
  },
  middleware: {
    historyRepair: passthrough,
  },
};

// Module-load side effect: register this default at import time so
// downstream consumers (including tests that skip `bootstrapPlugins()`)
// observe a populated registry by default. Idempotent via the swallowed
// duplicate-name check. Kept local to this module (rather than iterating
// an array in `defaults/index.ts`) so the registration only references
// the already-initialized `defaultHistoryRepairPlugin` identifier —
// avoiding a TDZ crash when tests `mock.module(...)` a dependency of any
// other default plugin and directly import this file.
try {
  registerPlugin(defaultHistoryRepairPlugin);
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
