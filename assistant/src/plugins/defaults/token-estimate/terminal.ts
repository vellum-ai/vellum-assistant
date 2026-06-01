/**
 * Terminal handler for the default `tokenEstimate` pipeline.
 *
 * This module is side-effect free: importing it does not register any plugin.
 * The terminal is wired in as the pipeline's `terminal` argument by the
 * `runPipeline` call sites in `daemon/conversation-agent-loop.ts`.
 *
 * The terminal delegates to
 * {@link estimatePromptTokens}, which applies the EWMA calibration correction
 * recorded from past provider responses. Preflight + mid-loop checks must use
 * the calibrated estimate — the calibrated value keeps the overflow gate
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
} from "../../../context/token-estimator.js";
import type { EstimateArgs, EstimateResult } from "../../types.js";

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
