/**
 * Default `tokenEstimate` plugin.
 *
 * The plugin's middleware is a passthrough — it calls `next(args)` and returns
 * the result unchanged. The actual estimate lives in
 * {@link defaultTokenEstimateTerminal}, which is wired in as the pipeline's
 * `terminal` argument by `runPipeline` call sites in
 * `daemon/conversation-agent-loop.ts`. This separation matters: the default
 * plugin is registered before any user plugin (defaults load first in
 * `bootstrapPlugins()`), which puts it at the OUTERMOST position of the onion
 * chain. If the default middleware were to invoke the terminal directly
 * without calling `next`, it would shadow every later-registered plugin. The
 * passthrough lets user middleware that wraps the default (e.g. a doubler, a
 * provider-native `countTokens` override) participate normally.
 *
 * The terminal delegates to
 * {@link import("../../context/token-estimator.js").estimatePromptTokens estimatePromptTokens},
 * which applies the EWMA calibration correction recorded from past provider
 * responses. Preflight + mid-loop checks must use the calibrated estimate —
 * before this pipeline existed, both call sites invoked `estimatePromptTokens`
 * directly, and the calibrated estimate is what keeps the overflow gate
 * consistent with the convergence path in the reducer. The pre-send
 * calibration capture in `agent/loop.ts` still uses `estimatePromptTokensRaw`
 * on purpose — the calibrator must learn against the raw estimate so the EWMA
 * converges against provider ground truth rather than chasing its own
 * corrected output. Pipelines produce user-facing estimates; calibration
 * capture stays outside the pipeline.
 */

import {
  estimatePromptTokens,
  estimateToolsTokens,
} from "../../context/token-estimator.js";
import { registerPlugin } from "../registry.js";
import {
  type EstimateArgs,
  type EstimateResult,
  type Middleware,
  type Plugin,
  PluginExecutionError,
} from "../types.js";

/**
 * Terminal handler for the `tokenEstimate` pipeline. Computes the tool token
 * budget from `args.tools` and delegates to {@link estimatePromptTokens} with
 * the canonical provider key, applying the EWMA calibration correction.
 * Exported so tests can verify default behavior directly without going through
 * `runPipeline`, and so `daemon/conversation-agent-loop.ts` can pass it as the
 * `terminal` argument to `runPipeline`.
 */
export const defaultTokenEstimateTerminal = async (
  args: EstimateArgs,
): Promise<EstimateResult> => {
  const toolTokenBudget =
    args.tools.length > 0 ? estimateToolsTokens(args.tools) : 0;
  return estimatePromptTokens(args.history, args.systemPrompt, {
    providerName: args.providerName,
    toolTokenBudget,
  });
};

const passthrough: Middleware<EstimateArgs, EstimateResult> = async (
  args,
  next,
) => next(args);

/**
 * Default `tokenEstimate` plugin. Registered by
 * {@link bootstrapPlugins} on daemon startup so the pipeline always has a
 * terminal handler even when no other plugin contributes one.
 */
export const defaultTokenEstimatePlugin: Plugin = {
  manifest: {
    name: "default-token-estimate",
    version: "1.0.0",
    provides: { tokenEstimate: "v1" },
    requires: { pluginRuntime: "v1", tokenEstimateApi: "v1" },
  },
  middleware: {
    tokenEstimate: passthrough,
  },
};

// Module-load side effect: register this default at import time so
// downstream consumers (including tests that skip `bootstrapPlugins()`)
// observe a populated registry by default. Idempotent via the swallowed
// duplicate-name check. Kept local to this module (rather than iterating
// an array in `defaults/index.ts`) so the registration only references
// the already-initialized `defaultTokenEstimatePlugin` identifier —
// avoiding a TDZ crash when tests `mock.module(...)` a dependency of any
// other default plugin and directly import this file.
try {
  registerPlugin(defaultTokenEstimatePlugin);
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
