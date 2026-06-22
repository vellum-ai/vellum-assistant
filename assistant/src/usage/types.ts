import type { LLMCallSite } from "../config/schemas/llm.js";
import type { UsageActor } from "./actors.js";
import type { UsageAttributionProfileSource } from "./attribution.js";

export type {
  UsageAttributionInput,
  UsageAttributionProfileSource,
  UsageAttributionSnapshot,
} from "./attribution.js";

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
  /**
   * The provider's untouched `usage` block (the literal object returned in
   * the API response), preserved as JSON so downstream consumers can
   * extract any provider-specific detail without requiring a schema
   * change. Anthropic nests its TTL breakdown under
   * `cache_creation.ephemeral_{5m,1h}_input_tokens`; OpenAI nests cached
   * read counts under `prompt_tokens_details.cached_tokens`; both shapes
   * are stored as-is. `null` when the provider did not return a usage
   * block and for rows persisted before the
   * `260-llm-usage-add-raw-usage` migration.
   */
  rawUsage: Record<string, unknown> | null;
  actor: UsageActor;
  conversationId: string | null;
  runId: string | null;
  requestId: string | null;
  callSite?: LLMCallSite | null;
  inferenceProfile?: string | null;
  inferenceProfileSource?: UsageAttributionProfileSource | null;
  /** Number of actual LLM API calls represented by this event (defaults to 1). */
  llmCallCount?: number | null;
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
  callSite: LLMCallSite | null;
  inferenceProfile: string | null;
  inferenceProfileSource: UsageAttributionProfileSource | null;
  estimatedCostUsd: number | null;
  pricingStatus: "priced" | "unpriced";
  /**
   * Number of provider API calls aggregated into this event. The main agent
   * loop persists one row per turn with this set to the number of calls in
   * the loop; auxiliary call sites persist 1. `null` only for rows persisted
   * before migration `200-usage-llm-call-count` ran.
   */
  llmCallCount: number | null;
  /**
   * Version of the assistant binary at the moment this event was
   * RECORDED, captured by `recordUsageEvent` and persisted with the
   * row. Not provided by callers; computed at record time. Surfaces
   * onto the telemetry wire as `assistant_version` so analytics
   * stays truthful even when a batch flushes days after the events
   * fired. `null` only for rows persisted before migration 267 ran.
   * See `migrations/267-llm-usage-events-add-assistant-version.ts`.
   */
  assistantVersion: string | null;
}
