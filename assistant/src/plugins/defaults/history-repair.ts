/**
 * Default `historyRepair` plugin — preserves pre-plugins behavior.
 *
 * Wraps {@link repairHistory} from `daemon/history-repair.ts`. The orchestrator
 * invokes this pipeline once per turn, just before the provider call, to
 * collapse common history drift (orphan tool_result blocks, missing
 * tool_result blocks, same-role-consecutive messages). The deep-repair
 * fallback (`deepRepairHistory`) — invoked only after a provider ordering
 * error — remains a direct call in the orchestrator for now; future PRs can
 * widen the pipeline if deep-repair turns out to have swap points worth
 * exposing to plugin authors.
 *
 * Plugins that override this middleware receive both `history` and `provider`
 * so they can route behavior per provider (e.g. strip blocks a specific
 * provider can't handle) without reaching into ambient state.
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
 * verify default behavior directly without going through `runPipeline`.
 */
export function defaultHistoryRepairTerminal(
  args: HistoryRepairArgs,
): HistoryRepairResult {
  return repairHistory(args.history);
}

const terminal: Middleware<HistoryRepairArgs, HistoryRepairResult> = async (
  args,
) => defaultHistoryRepairTerminal(args);

export const defaultHistoryRepairPlugin: Plugin = {
  manifest: {
    name: "default-history-repair",
    version: "1.0.0",
    provides: { historyRepair: "v1" },
    requires: { pluginRuntime: "v1", historyRepairApi: "v1" },
  },
  middleware: {
    historyRepair: terminal,
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
