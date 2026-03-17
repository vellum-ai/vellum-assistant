/**
 * Query media tool - sends natural language queries against video
 * analysis data (map output) via Claude for intelligent answers.
 *
 * Replaces the old keyword-matching approach with an LLM-powered
 * reduce/query step that can answer arbitrary questions about the
 * video content.
 */

import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import {
  reduceForAsset,
  type ReduceOptions,
  type ReduceResult,
} from "../services/reduce.js";

// ---------------------------------------------------------------------------
// Exported function for job handler use (one-shot merge mode)
// ---------------------------------------------------------------------------

export { reduceForAsset } from "../services/reduce.js";

// ---------------------------------------------------------------------------
// Tool entry point
// ---------------------------------------------------------------------------

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const assetId = input.asset_id as string | undefined;
  if (!assetId) {
    return { content: "asset_id is required.", isError: true };
  }

  const query = input.query as string | undefined;
  if (!query) {
    return { content: "query is required.", isError: true };
  }

  const systemPrompt = input.system_prompt as string | undefined;
  const model = input.model as string | undefined;

  const options: ReduceOptions = {
    query,
    systemPrompt,
    model,
  };

  try {
    const result: ReduceResult = await reduceForAsset(
      assetId,
      options,
      context.onOutput,
    );

    return {
      content: JSON.stringify(
        {
          query,
          answer: result.answer,
          model: result.model,
          usage: {
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
          },
        },
        null,
        2,
      ),
      isError: false,
    };
  } catch (err) {
    const msg = (err as Error).message;
    return { content: msg, isError: true };
  }
}
