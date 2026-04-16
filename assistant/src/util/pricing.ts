import type { ModelPricingOverride } from "../config/schema.js";
import type { PricingResult, PricingUsage } from "../usage/types.js";

interface ModelPricing {
  inputPer1M: number; // USD per 1M input tokens
  outputPer1M: number; // USD per 1M output tokens
}

const ANTHROPIC_PROMPT_CACHE_MULTIPLIERS = {
  read: 0.1,
  write5m: 1.25,
  write1h: 2,
} as const;

/** Fast mode pricing is 6x standard rates for all token types. */
const ANTHROPIC_FAST_MODE_MULTIPLIER = 6;

/**
 * Multi-provider pricing catalog keyed by provider then model pattern.
 * Model patterns are matched by exact match first, then by prefix.
 */
const PROVIDER_PRICING: Record<string, Record<string, ModelPricing>> = {
  anthropic: {
    "claude-opus-4-7": { inputPer1M: 5, outputPer1M: 25 },
    "claude-opus-4-6": { inputPer1M: 5, outputPer1M: 25 },
    "claude-opus-4": { inputPer1M: 15, outputPer1M: 75 },
    "claude-sonnet-4": { inputPer1M: 3, outputPer1M: 15 },
    "claude-haiku-4": { inputPer1M: 0.8, outputPer1M: 4 },
  },
  openai: {
    "gpt-5.4": { inputPer1M: 2.5, outputPer1M: 15 },
    "gpt-5.4-mini": { inputPer1M: 0.5, outputPer1M: 3 },
    "gpt-5.4-nano": { inputPer1M: 0.2, outputPer1M: 1.25 },
    "gpt-5.2": { inputPer1M: 1.75, outputPer1M: 14 },
    "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10 },
    "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
    "gpt-4.1": { inputPer1M: 2.0, outputPer1M: 8.0 },
    "gpt-4.1-mini": { inputPer1M: 0.4, outputPer1M: 1.6 },
    "gpt-4.1-nano": { inputPer1M: 0.1, outputPer1M: 0.4 },
    o3: { inputPer1M: 2.0, outputPer1M: 8.0 },
    "o3-mini": { inputPer1M: 1.1, outputPer1M: 4.4 },
    "o3-pro": { inputPer1M: 20, outputPer1M: 80 },
    "o4-mini": { inputPer1M: 1.1, outputPer1M: 4.4 },
  },
  gemini: {
    "gemini-3-flash": { inputPer1M: 0.5, outputPer1M: 3 },
    "gemini-2.5-pro": { inputPer1M: 1.25, outputPer1M: 10 },
    "gemini-2.5-flash": { inputPer1M: 0.15, outputPer1M: 0.6 },
    "gemini-2.0-flash": { inputPer1M: 0.1, outputPer1M: 0.4 },
  },
  fireworks: {
    "accounts/fireworks/models/kimi-k2p5": {
      inputPer1M: 0.6,
      outputPer1M: 3.0,
    },
  },
};

/**
 * Identify a model ID as an Anthropic model — accepts both the OpenRouter
 * prefix form (`anthropic/claude-opus-4.6`) and the bare Anthropic slug
 * (`claude-opus-4-6`) that `response.model` sometimes carries.
 */
function isAnthropicModelId(model: string): boolean {
  return model.startsWith("anthropic/") || model.startsWith("claude-");
}

/**
 * Normalize an OpenRouter-style Anthropic model ID for lookup against the
 * Anthropic catalog: strip the `anthropic/` prefix and convert OpenRouter's
 * dot-separated version tokens (`claude-opus-4.6`) to the dash form Anthropic
 * uses natively (`claude-opus-4-6`).
 */
function normalizeAnthropicModelId(model: string): string {
  const bare = model.startsWith("anthropic/")
    ? model.slice("anthropic/".length)
    : model;
  return bare.replace(/\./g, "-");
}

/**
 * Whether Anthropic's pricing rules (cache-read/write multipliers, fast-mode
 * surcharge) apply for the given provider/model. True for direct Anthropic
 * calls and for Anthropic models routed through OpenRouter — OpenRouter
 * proxies to Anthropic's Messages API, so the usage response carries the
 * same cache and speed fields and is charged at Anthropic's rates.
 */
export function usesAnthropicPricingRules(
  provider: string,
  model: string,
): boolean {
  if (provider === "anthropic") return true;
  if (provider === "openrouter" && isAnthropicModelId(model)) return true;
  return false;
}

/**
 * Look up pricing for a model within a provider's catalog.
 * Tries exact match first, then longest prefix match.
 */
function findPricing(
  catalog: Record<string, ModelPricing>,
  model: string,
): ModelPricing | undefined {
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

function findOverride(
  overrides: ModelPricingOverride[] | undefined,
  provider: string,
  model: string,
): ModelPricingOverride | undefined {
  if (!overrides || overrides.length === 0) return undefined;

  let bestOverride: ModelPricingOverride | undefined;
  let bestLen = 0;
  for (const override of overrides) {
    if (override.provider !== provider) continue;
    if (
      model === override.modelPattern ||
      model.startsWith(override.modelPattern)
    ) {
      if (override.modelPattern.length > bestLen) {
        bestOverride = override;
        bestLen = override.modelPattern.length;
      }
    }
  }

  return bestOverride;
}

/**
 * Calculate cost from a rate and token count.
 */
function calculateTokenCost(ratePer1M: number, tokens: number): number {
  return (Math.max(tokens, 0) / 1_000_000) * ratePer1M;
}

function getAnthropicCacheWriteTokens(usage: PricingUsage): {
  ephemeral5mInputTokens: number;
  ephemeral1hInputTokens: number;
} {
  const totalCacheCreationTokens = Math.max(usage.cacheCreationInputTokens, 0);
  const explicit5mTokens = Math.max(
    usage.anthropicCacheCreation?.ephemeral_5m_input_tokens ?? 0,
    0,
  );
  const explicit1hTokens = Math.max(
    usage.anthropicCacheCreation?.ephemeral_1h_input_tokens ?? 0,
    0,
  );

  if (explicit5mTokens === 0 && explicit1hTokens === 0) {
    return {
      ephemeral5mInputTokens: totalCacheCreationTokens,
      ephemeral1hInputTokens: 0,
    };
  }

  const remaining5mTokens = Math.max(
    totalCacheCreationTokens - explicit5mTokens - explicit1hTokens,
    0,
  );

  return {
    ephemeral5mInputTokens: explicit5mTokens + remaining5mTokens,
    ephemeral1hInputTokens: explicit1hTokens,
  };
}

/**
 * Calculate provider-aware usage cost from normalized token categories.
 */
function calculateUsageCost(
  provider: string,
  model: string,
  pricing: ModelPricing,
  usage: PricingUsage,
): number {
  const useAnthropicRules = usesAnthropicPricingRules(provider, model);
  // Anthropic fast mode: 6x multiplier on base rates (cache multipliers stack on top)
  const speedMultiplier =
    useAnthropicRules && usage.speed === "fast"
      ? ANTHROPIC_FAST_MODE_MULTIPLIER
      : 1;
  const effectivePricing: ModelPricing = {
    inputPer1M: pricing.inputPer1M * speedMultiplier,
    outputPer1M: pricing.outputPer1M * speedMultiplier,
  };

  const directInputCost = calculateTokenCost(
    effectivePricing.inputPer1M,
    usage.directInputTokens,
  );
  const outputCost = calculateTokenCost(
    effectivePricing.outputPer1M,
    usage.outputTokens,
  );

  if (!useAnthropicRules) {
    return (
      directInputCost +
      outputCost +
      calculateTokenCost(
        effectivePricing.inputPer1M,
        usage.cacheCreationInputTokens + usage.cacheReadInputTokens,
      )
    );
  }

  const { ephemeral5mInputTokens, ephemeral1hInputTokens } =
    getAnthropicCacheWriteTokens(usage);

  return (
    directInputCost +
    outputCost +
    calculateTokenCost(
      effectivePricing.inputPer1M * ANTHROPIC_PROMPT_CACHE_MULTIPLIERS.read,
      usage.cacheReadInputTokens,
    ) +
    calculateTokenCost(
      effectivePricing.inputPer1M * ANTHROPIC_PROMPT_CACHE_MULTIPLIERS.write5m,
      ephemeral5mInputTokens,
    ) +
    calculateTokenCost(
      effectivePricing.inputPer1M * ANTHROPIC_PROMPT_CACHE_MULTIPLIERS.write1h,
      ephemeral1hInputTokens,
    )
  );
}

function createDirectUsage(
  inputTokens: number,
  outputTokens: number,
): PricingUsage {
  return {
    directInputTokens: inputTokens,
    outputTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    anthropicCacheCreation: null,
  };
}

/**
 * Resolve pricing for a normalized usage breakdown using the built-in catalog.
 * Returns a PricingResult with explicit priced/unpriced status.
 */
export function resolvePricingForUsage(
  provider: string,
  model: string,
  usage: PricingUsage,
): PricingResult {
  // Anthropic models routed through OpenRouter: look up against the Anthropic
  // catalog using the normalized bare slug. OpenRouter bills these calls at
  // Anthropic's rates and the underlying Messages API response includes
  // Anthropic's cache- and speed-metadata fields.
  if (provider === "openrouter" && isAnthropicModelId(model)) {
    const anthropicCatalog = PROVIDER_PRICING.anthropic;
    if (anthropicCatalog) {
      const pricing = findPricing(
        anthropicCatalog,
        normalizeAnthropicModelId(model),
      );
      if (pricing) {
        return {
          estimatedCostUsd: calculateUsageCost(provider, model, pricing, usage),
          pricingStatus: "priced",
        };
      }
    }
    return { estimatedCostUsd: null, pricingStatus: "unpriced" };
  }

  const providerCatalog = PROVIDER_PRICING[provider];
  if (!providerCatalog) {
    return { estimatedCostUsd: null, pricingStatus: "unpriced" };
  }

  const pricing = findPricing(providerCatalog, model);
  if (!pricing) {
    return { estimatedCostUsd: null, pricingStatus: "unpriced" };
  }

  return {
    estimatedCostUsd: calculateUsageCost(provider, model, pricing, usage),
    pricingStatus: "priced",
  };
}

/**
 * Resolve provider-aware pricing with optional custom model overrides checked first.
 */
export function resolvePricingForUsageWithOverrides(
  provider: string,
  model: string,
  usage: PricingUsage,
  overrides?: ModelPricingOverride[],
): PricingResult {
  const bestOverride = findOverride(overrides, provider, model);
  if (bestOverride) {
    return {
      estimatedCostUsd: calculateUsageCost(
        provider,
        model,
        {
          inputPer1M: bestOverride.inputPer1M,
          outputPer1M: bestOverride.outputPer1M,
        },
        usage,
      ),
      pricingStatus: "priced",
    };
  }

  return resolvePricingForUsage(provider, model, usage);
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
  return resolvePricingForUsage(
    provider,
    model,
    createDirectUsage(inputTokens, outputTokens),
  );
}
