interface ModelPricing {
  inputPer1M: number;  // USD per 1M input tokens
  outputPer1M: number; // USD per 1M output tokens
}

const PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-5-20250929':   { inputPer1M: 15, outputPer1M: 75 },
  'claude-sonnet-4-5-20250929': { inputPer1M: 3, outputPer1M: 15 },
  'claude-haiku-4-5-20251001':  { inputPer1M: 0.80, outputPer1M: 4 },
};

/**
 * Estimate cost in USD for the given token counts and model.
 * Returns 0 if the model is not in the pricing table.
 */
export function estimateCost(
  inputTokens: number,
  outputTokens: number,
  model: string,
): number {
  const pricing = PRICING[model]
    ?? Object.entries(PRICING).find(([key]) => model.startsWith(key))?.[1];
  if (!pricing) return 0;
  return (inputTokens / 1_000_000) * pricing.inputPer1M
       + (outputTokens / 1_000_000) * pricing.outputPer1M;
}
