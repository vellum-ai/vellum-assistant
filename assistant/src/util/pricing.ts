import type { ModelPricingOverride } from "../config/schema.js";
import { isAnthropicDelegatingGateway } from "../providers/anthropic-gateway-shared.js";
import type {
  CatalogModel,
  CatalogModelPricing,
  CatalogModelPricingTier,
} from "../providers/model-catalog.js";
import { PROVIDER_CATALOG } from "../providers/model-catalog.js";
import type { PricingResult, PricingUsage } from "../usage/types.js";

interface ModelPricing {
  inputPer1M: number; // USD per 1M input tokens
  outputPer1M: number; // USD per 1M output tokens
  cacheReadPer1M?: number; // USD per 1M cache-read input tokens
  tiers?: ModelPricingTier[];
}

interface ModelPricingTier {
  inputTokenThreshold: number;
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M?: number;
}

const ANTHROPIC_PROMPT_CACHE_MULTIPLIERS = {
  read: 0.1,
  write5m: 1.25,
  write1h: 2,
} as const;

/** Fast mode pricing is 6x standard rates for all token types. */
const ANTHROPIC_FAST_MODE_MULTIPLIER = 6;

/**
 * Pricing fallback for vendor-versioned IDs that don't match a catalog row
 * directly. Keys are bare-prefix slugs (`claude-opus-4`, `gpt-4o`) used to
 * price IDs like `claude-opus-4-5-20250929` or `gpt-4o-mini-2024-07-18`
 * before the catalog is updated for a new version.
 *
 * `findPricing` checks the catalog first (including longest-prefix match
 * against `CatalogModel.id`); this fallback only fires when nothing in the
 * catalog matches.
 */
const LEGACY_PRICING_FALLBACK: Record<string, Record<string, ModelPricing>> = {
  anthropic: {
    "claude-opus-4": { inputPer1M: 5, outputPer1M: 25 },
    "claude-sonnet-4": { inputPer1M: 3, outputPer1M: 15 },
    "claude-haiku-4": { inputPer1M: 1, outputPer1M: 5 },
  },
  openai: {
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
    "gemini-2.0-flash": { inputPer1M: 0.1, outputPer1M: 0.4 },
  },
};

/** Convert a catalog pricing entry to the internal pricing shape. */
function catalogPricingToInternal(p: CatalogModelPricing): ModelPricing {
  return {
    inputPer1M: p.inputPer1mTokens,
    outputPer1M: p.outputPer1mTokens,
    cacheReadPer1M: p.cacheReadPer1mTokens,
    tiers: p.tiers?.map(catalogTierToInternal),
  };
}

function catalogTierToInternal(
  tier: CatalogModelPricingTier,
): ModelPricingTier {
  return {
    inputTokenThreshold: tier.inputTokenThreshold,
    inputPer1M: tier.inputPer1mTokens,
    outputPer1M: tier.outputPer1mTokens,
    cacheReadPer1M: tier.cacheReadPer1mTokens,
  };
}

/** Look up pricing for a model against `PROVIDER_CATALOG`. */
function findCatalogPricing(
  provider: string,
  model: string,
): ModelPricing | undefined {
  const entry = PROVIDER_CATALOG.find((p) => p.id === provider);
  if (!entry) return undefined;
  // Exact match
  const exact = entry.models.find((m) => m.id === model && m.pricing);
  if (exact?.pricing) return catalogPricingToInternal(exact.pricing);
  // Longest-prefix match against catalog model IDs
  let best: CatalogModel | undefined;
  let bestLen = 0;
  for (const m of entry.models) {
    if (!m.pricing) continue;
    if (model.startsWith(m.id) && m.id.length > bestLen) {
      best = m;
      bestLen = m.id.length;
    }
  }
  return best?.pricing ? catalogPricingToInternal(best.pricing) : undefined;
}

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
 * Anthropic catalog: strip the `anthropic/` prefix, convert OpenRouter's
 * dot-separated version tokens (`claude-opus-4.6`) to the dash form Anthropic
 * uses natively (`claude-opus-4-6`), and swap OpenRouter's version-first
 * response form (`claude-4-7-opus-20260416`) into Anthropic's model-first
 * catalog form (`claude-opus-4-7-20260416`) so the prefix match succeeds.
 */
function normalizeAnthropicModelId(model: string): string {
  const bare = model.startsWith("anthropic/")
    ? model.slice("anthropic/".length)
    : model;
  const dashed = bare.replace(/\./g, "-");
  const versionFirst = dashed.match(
    /^claude-(\d+(?:-\d+)*)-(opus|sonnet|haiku)(-.+)?$/,
  );
  if (versionFirst) {
    const [, version, family, suffix] = versionFirst;
    return `claude-${family}-${version}${suffix ?? ""}`;
  }
  return dashed;
}

/**
 * Whether Anthropic's pricing rules (cache-read/write multipliers, fast-mode
 * surcharge) apply for the given provider/model. True for direct Anthropic
 * calls and for Anthropic models routed through OpenRouter or the Vercel AI
 * Gateway — both gateways proxy `anthropic/*` to Anthropic's Messages API, so
 * the usage response carries the same cache and speed fields and is charged
 * at Anthropic's rates.
 */
export function usesAnthropicPricingRules(
  provider: string,
  model: string,
): boolean {
  if (provider === "anthropic") {
    return true;
  }
  return isAnthropicDelegatingGateway(provider) && isAnthropicModelId(model);
}

/**
 * Look up pricing for a model within a provider's pricing table.
 * Tries exact match first, then longest prefix match.
 */
function findInFallback(
  table: Record<string, ModelPricing>,
  model: string,
): ModelPricing | undefined {
  // Exact match
  if (table[model]) return table[model];

  // Prefix match: find the longest matching prefix
  let bestMatch: ModelPricing | undefined;
  let bestLen = 0;
  for (const [pattern, pricing] of Object.entries(table)) {
    if (model.startsWith(pattern) && pattern.length > bestLen) {
      bestMatch = pricing;
      bestLen = pattern.length;
    }
  }
  return bestMatch;
}

/**
 * Resolve a model's pricing: catalog first, then legacy fallback.
 * Returns undefined when no entry matches.
 */
function findPricing(
  provider: string,
  model: string,
): ModelPricing | undefined {
  const fromCatalog = findCatalogPricing(provider, model);
  if (fromCatalog) return fromCatalog;
  const fallbackTable = LEGACY_PRICING_FALLBACK[provider];
  if (!fallbackTable) return undefined;
  return findInFallback(fallbackTable, model);
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

function getTotalPromptInputTokens(usage: PricingUsage): number {
  return (
    Math.max(usage.directInputTokens, 0) +
    Math.max(usage.cacheCreationInputTokens, 0) +
    Math.max(usage.cacheReadInputTokens, 0)
  );
}

function selectPricingTier(
  pricing: ModelPricing,
  usage: PricingUsage,
): ModelPricing {
  if (!pricing.tiers || pricing.tiers.length === 0) return pricing;

  const totalPromptInputTokens = getTotalPromptInputTokens(usage);
  let selectedTier: ModelPricingTier | undefined;
  for (const tier of pricing.tiers) {
    if (
      totalPromptInputTokens > tier.inputTokenThreshold &&
      (!selectedTier ||
        tier.inputTokenThreshold > selectedTier.inputTokenThreshold)
    ) {
      selectedTier = tier;
    }
  }

  if (!selectedTier) return pricing;

  return {
    ...pricing,
    inputPer1M: selectedTier.inputPer1M,
    outputPer1M: selectedTier.outputPer1M,
    cacheReadPer1M: selectedTier.cacheReadPer1M ?? pricing.cacheReadPer1M,
  };
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
  const tieredPricing = selectPricingTier(pricing, usage);
  // Anthropic fast mode: 6x multiplier on base rates (cache multipliers stack on top)
  const speedMultiplier =
    useAnthropicRules && usage.speed === "fast"
      ? ANTHROPIC_FAST_MODE_MULTIPLIER
      : 1;
  const effectivePricing: ModelPricing = {
    inputPer1M: tieredPricing.inputPer1M * speedMultiplier,
    outputPer1M: tieredPricing.outputPer1M * speedMultiplier,
    cacheReadPer1M:
      tieredPricing.cacheReadPer1M == null
        ? undefined
        : tieredPricing.cacheReadPer1M * speedMultiplier,
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
        usage.cacheCreationInputTokens,
      ) +
      calculateTokenCost(
        effectivePricing.cacheReadPer1M ?? effectivePricing.inputPer1M,
        usage.cacheReadInputTokens,
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
  // Anthropic models routed through OpenRouter or the Vercel AI Gateway: look
  // up against the Anthropic catalog using the normalized bare slug. Both
  // gateways bill these calls at Anthropic's rates and the underlying Messages
  // API response includes Anthropic's cache- and speed-metadata fields.
  if (isAnthropicDelegatingGateway(provider) && isAnthropicModelId(model)) {
    const pricing = findPricing("anthropic", normalizeAnthropicModelId(model));
    if (pricing) {
      return {
        estimatedCostUsd: calculateUsageCost(provider, model, pricing, usage),
        pricingStatus: "priced",
      };
    }
    return { estimatedCostUsd: null, pricingStatus: "unpriced" };
  }

  const pricing = findPricing(provider, model);
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
