/**
 * Default `tokenEstimate` behavior: estimates the prompt token count used by
 * the overflow gate.
 *
 * This module is side-effect free: importing it does not register any plugin.
 *
 * Delegates to
 * {@link estimatePromptTokens}, which applies the EWMA calibration correction
 * recorded from past provider responses. Preflight + mid-loop checks must use
 * the calibrated estimate — the calibrated value keeps the overflow gate
 * consistent with the convergence path in the reducer. The pre-send
 * calibration capture in `agent/loop.ts` still uses `estimatePromptTokensRaw`
 * on purpose — the calibrator must learn against the raw estimate so the EWMA
 * converges against provider ground truth rather than chasing its own
 * corrected output. This path produces the user-facing estimate; calibration
 * capture stays separate.
 */

import {
  estimatePromptTokens,
  estimateToolsTokens,
} from "../../../context/token-estimator.js";
import type { EstimateArgs, EstimateResult } from "../../types.js";

/**
 * Compute the tool token budget from `args.tools` and delegate to
 * {@link estimatePromptTokens} with the canonical provider key, applying the
 * EWMA calibration correction. Exported so the agent loop can call it directly
 * and tests can verify the default behavior.
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
