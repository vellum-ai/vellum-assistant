/**
 * Default `tokenEstimate` pipeline plugin.
 *
 * The `tokenEstimate` pipeline produces the user-facing prompt-token estimate
 * the orchestrator consults before calling a provider — the value that drives
 * preflight overflow gating and the mid-loop checkpoint yield decision. This
 * plugin's terminal middleware delegates to
 * {@link import("../../context/token-estimator.js").estimatePromptTokensRaw estimatePromptTokensRaw},
 * so the default output matches the uncalibrated raw estimator.
 *
 * The calibration path in `agent/loop.ts` (pre-send raw estimate recorded
 * alongside provider-reported ground truth) stays outside the pipeline on
 * purpose: calibration must see the raw estimate so the EWMA learns against
 * provider truth instead of chasing its own corrected output. Pipelines are
 * for user-facing estimates only.
 *
 * Custom plugins can override by contributing their own `tokenEstimate`
 * middleware via the registry — e.g. a plugin that calls a provider-native
 * `countTokens` endpoint and short-circuits the chain by skipping `next`.
 */

import {
  estimatePromptTokensRaw,
  estimateToolsTokens,
} from "../../context/token-estimator.js";
import type { EstimateArgs, EstimateResult, Plugin } from "../types.js";

/**
 * Terminal middleware for the `tokenEstimate` pipeline. Computes the tool
 * token budget from `args.tools` and delegates to {@link estimatePromptTokensRaw}
 * with the canonical provider key. Short-circuits the chain by ignoring
 * `next` — this plugin is the last stop when no other plugin supplies its
 * own `tokenEstimate` middleware.
 */
export const defaultTokenEstimateTerminal = async (
  args: EstimateArgs,
): Promise<EstimateResult> => {
  const toolTokenBudget =
    args.tools.length > 0 ? estimateToolsTokens(args.tools) : 0;
  return estimatePromptTokensRaw(args.history, args.systemPrompt, {
    providerName: args.providerName,
    toolTokenBudget,
  });
};

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
    tokenEstimate: async (args, _next, _ctx) =>
      defaultTokenEstimateTerminal(args),
  },
};
