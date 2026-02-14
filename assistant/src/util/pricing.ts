import type { PricingResult } from '../usage/types.js';
import type { ModelPricingOverride } from '../config/schema.js';

interface ModelPricing {
  inputPer1M: number;  // USD per 1M input tokens
  outputPer1M: number; // USD per 1M output tokens
}

/**
 * Multi-provider pricing catalog keyed by provider then model pattern.
 * Model patterns are matched by exact match first, then by prefix.
 */
const PROVIDER_PRICING: Record<string, Record<string, ModelPricing>> = {
  anthropic: {
    'claude-opus-4': { inputPer1M: 15, outputPer1M: 75 },
    'claude-sonnet-4': { inputPer1M: 3, outputPer1M: 15 },
    'claude-haiku-4': { inputPer1M: 0.80, outputPer1M: 4 },
  },
  openai: {
    'gpt-4o': { inputPer1M: 2.50, outputPer1M: 10 },
    'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.60 },
    'gpt-4.1': { inputPer1M: 2.00, outputPer1M: 8.00 },
    'gpt-4.1-mini': { inputPer1M: 0.40, outputPer1M: 1.60 },
    'gpt-4.1-nano': { inputPer1M: 0.10, outputPer1M: 0.40 },
    'o3': { inputPer1M: 2.00, outputPer1M: 8.00 },
    'o3-mini': { inputPer1M: 1.10, outputPer1M: 4.40 },
    'o3-pro': { inputPer1M: 20, outputPer1M: 80 },
    'o4-mini': { inputPer1M: 1.10, outputPer1M: 4.40 },
  },
  gemini: {
    'gemini-2.5-pro': { inputPer1M: 1.25, outputPer1M: 10 },
    'gemini-2.5-flash': { inputPer1M: 0.15, outputPer1M: 0.60 },
    'gemini-2.0-flash': { inputPer1M: 0.10, outputPer1M: 0.40 },
  },
  fireworks: {
    'accounts/fireworks/models/kimi-k2p5': { inputPer1M: 0.60, outputPer1M: 3.00 },
  },
};

/**
 * Look up pricing for a model within a provider's catalog.
 * Tries exact match first, then longest prefix match.
 */
function findPricing(catalog: Record<string, ModelPricing>, model: string): ModelPricing | undefined {
  // Exact match
  if (catalog[model]) return catalog[model];

  // Prefix match: find the longest matching prefix
  let bestMatch: ModelPricing | undefined;
  let bestLen = 0;
  for (const [pattern, pricing] of Object.entries(catalog)) {
    if (model.startsWith(pattern) && pattern.length > bestLen) {
      bestMatch = pricing;
      bestLen = pattern.length;
    }
  }
  return bestMatch;
}

/**
 * Calculate cost from pricing and token counts.
 */
function calculateCost(pricing: ModelPricing, inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1_000_000) * pricing.inputPer1M
       + (outputTokens / 1_000_000) * pricing.outputPer1M;
}

/**
 * Resolve pricing for a provider/model combination using the built-in catalog.
 * Returns a PricingResult with explicit priced/unpriced status.
 */
export function resolvePricing(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): PricingResult {
  const providerCatalog = PROVIDER_PRICING[provider];
  if (!providerCatalog) {
    return { estimatedCostUsd: null, pricingStatus: 'unpriced' };
  }

  const pricing = findPricing(providerCatalog, model);
  if (!pricing) {
    return { estimatedCostUsd: null, pricingStatus: 'unpriced' };
  }

  return {
    estimatedCostUsd: calculateCost(pricing, inputTokens, outputTokens),
    pricingStatus: 'priced',
  };
}

/**
 * Resolve pricing with optional custom model overrides checked first.
 * Overrides are matched by provider (exact) and modelPattern (prefix match).
 * Falls back to the built-in catalog if no override matches.
 */
export function resolvePricingWithOverrides(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  overrides?: ModelPricingOverride[],
): PricingResult {
  if (overrides && overrides.length > 0) {
    // Find matching overrides for this provider, use longest modelPattern prefix match
    let bestOverride: ModelPricingOverride | undefined;
    let bestLen = 0;
    for (const override of overrides) {
      if (override.provider !== provider) continue;
      // Exact match or prefix match on modelPattern
      if (model === override.modelPattern || model.startsWith(override.modelPattern)) {
        if (override.modelPattern.length > bestLen) {
          bestOverride = override;
          bestLen = override.modelPattern.length;
        }
      }
    }
    if (bestOverride) {
      const cost = calculateCost(
        { inputPer1M: bestOverride.inputPer1M, outputPer1M: bestOverride.outputPer1M },
        inputTokens,
        outputTokens,
      );
      return { estimatedCostUsd: cost, pricingStatus: 'priced' };
    }
  }

  return resolvePricing(provider, model, inputTokens, outputTokens);
}

/**
 * Estimate cost in USD for the given token counts, provider, and model.
 * Returns 0 if the provider/model combination is not in the pricing table
 * (e.g. Ollama local models).
 */
export function estimateCost(
  inputTokens: number,
  outputTokens: number,
  model: string,
  provider: string,
): number {
  const result = resolvePricing(provider, model, inputTokens, outputTokens);
  if (result.pricingStatus === 'priced' && result.estimatedCostUsd !== null) {
    return result.estimatedCostUsd;
  }
  return 0;
}
