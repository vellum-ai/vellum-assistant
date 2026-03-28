import type { UsageActor } from "./actors.js";

/**
 * Anthropic prompt caching exposes write-tier detail so callers can price
 * 5-minute and 1-hour cache writes differently.
 */
export interface AnthropicCacheCreationTokenDetails {
  ephemeral_5m_input_tokens: number | null;
  ephemeral_1h_input_tokens: number | null;
}

/**
 * Structured token categories used for provider-aware pricing.
 * `directInputTokens` excludes cache reads and cache writes.
 */
export interface PricingUsage {
  directInputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  anthropicCacheCreation: AnthropicCacheCreationTokenDetails | null;
  /** Anthropic fast mode speed indicator from the API response. */
  speed?: "fast" | "standard" | null;
}

/**
 * Input data required to record a single LLM usage event.
 * Matches the token fields from `ProviderResponse.usage`.
 */
export interface UsageEventInput {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  actor: UsageActor;
  conversationId: string | null;
  runId: string | null;
  requestId: string | null;
}

/**
 * Result of resolving pricing for a usage event.
 */
export interface PricingResult {
  estimatedCostUsd: number | null;
  pricingStatus: "priced" | "unpriced";
}

/**
 * A persisted usage event, combining the original input with
 * storage metadata and resolved pricing.
 */
export interface UsageEvent extends UsageEventInput {
  id: string;
  createdAt: number;
  estimatedCostUsd: number | null;
  pricingStatus: "priced" | "unpriced";
}
