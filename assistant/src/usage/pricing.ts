import { getConfig } from "../config/loader.js";
import type { ProviderResponse } from "../providers/types.js";
import { getLogger } from "../util/logger.js";
import {
  resolvePricingForUsageWithOverrides,
  usesAnthropicPricingRules,
} from "../util/pricing.js";
import type {
  AnthropicCacheCreationTokenDetails,
  PricingResult,
  PricingUsage,
} from "./types.js";

const log = getLogger("usage-pricing");

export function normalizeTokenCount(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(value, 0);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value == null) return null;
  return value as Record<string, unknown>;
}

function extractAnthropicCacheCreationFromResponse(
  response: unknown,
): AnthropicCacheCreationTokenDetails | null {
  const rawResponse = asRecord(response);
  const usage = asRecord(rawResponse?.usage);
  const cacheCreation = asRecord(usage?.cache_creation);
  if (!cacheCreation) return null;

  return {
    ephemeral_5m_input_tokens: normalizeTokenCount(
      cacheCreation.ephemeral_5m_input_tokens as number | null | undefined,
    ),
    ephemeral_1h_input_tokens: normalizeTokenCount(
      cacheCreation.ephemeral_1h_input_tokens as number | null | undefined,
    ),
  };
}

function extractAnthropicCacheCreation(
  rawResponse: unknown,
): AnthropicCacheCreationTokenDetails | null {
  const responses = Array.isArray(rawResponse) ? rawResponse : [rawResponse];
  let foundDetails = false;
  let ephemeral5mInputTokens = 0;
  let ephemeral1hInputTokens = 0;

  for (const response of responses) {
    const details = extractAnthropicCacheCreationFromResponse(response);
    if (!details) continue;
    foundDetails = true;
    ephemeral5mInputTokens += normalizeTokenCount(
      details.ephemeral_5m_input_tokens,
    );
    ephemeral1hInputTokens += normalizeTokenCount(
      details.ephemeral_1h_input_tokens,
    );
  }

  if (!foundDetails) return null;

  return {
    ephemeral_5m_input_tokens: ephemeral5mInputTokens,
    ephemeral_1h_input_tokens: ephemeral1hInputTokens,
  };
}

/**
 * Extract the speed indicator from Anthropic fast mode API responses.
 * The API returns `usage.speed: "fast" | "standard"` when using the
 * fast-mode beta. For multi-response arrays, returns "fast" if any
 * response used fast mode.
 */
function extractAnthropicSpeed(
  rawResponse: unknown,
): "fast" | "standard" | null {
  const responses = Array.isArray(rawResponse) ? rawResponse : [rawResponse];
  let foundStandard = false;
  for (const response of responses) {
    const rec = asRecord(response);
    const usage = asRecord(rec?.usage);
    if (usage?.speed === "fast") return "fast";
    if (usage?.speed === "standard") foundStandard = true;
  }
  return foundStandard ? "standard" : null;
}

export function buildPricingUsage(input: {
  providerName: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  rawResponse?: unknown;
}): PricingUsage & {
  directInputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
} {
  const normalizedCacheCreationInputTokens = normalizeTokenCount(
    input.cacheCreationInputTokens,
  );
  const normalizedCacheReadInputTokens = normalizeTokenCount(
    input.cacheReadInputTokens,
  );
  const directInputTokens = Math.max(
    normalizeTokenCount(input.inputTokens) -
      normalizedCacheCreationInputTokens -
      normalizedCacheReadInputTokens,
    0,
  );

  const useAnthropicRules = usesAnthropicPricingRules(
    input.providerName,
    input.model,
  );
  return {
    directInputTokens,
    outputTokens: normalizeTokenCount(input.outputTokens),
    cacheCreationInputTokens: normalizedCacheCreationInputTokens,
    cacheReadInputTokens: normalizedCacheReadInputTokens,
    anthropicCacheCreation: useAnthropicRules
      ? extractAnthropicCacheCreation(input.rawResponse)
      : null,
    speed: useAnthropicRules ? extractAnthropicSpeed(input.rawResponse) : null,
  };
}

export function buildPricingUsageFromResponse(
  providerName: string,
  response: ProviderResponse,
): ReturnType<typeof buildPricingUsage> {
  return buildPricingUsage({
    providerName,
    model: response.model,
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    cacheCreationInputTokens: response.usage.cacheCreationInputTokens,
    cacheReadInputTokens: response.usage.cacheReadInputTokens,
    rawResponse: response.rawResponse,
  });
}

export function resolveStructuredPricing(
  providerName: string,
  model: string,
  usage: PricingUsage,
): PricingResult {
  try {
    const config = getConfig();
    return resolvePricingForUsageWithOverrides(
      providerName,
      model,
      usage,
      config.llm.pricingOverrides,
    );
  } catch (err) {
    log.warn({ err, model, providerName }, "Failed to resolve usage pricing");
    return { estimatedCostUsd: null, pricingStatus: "unpriced" };
  }
}
