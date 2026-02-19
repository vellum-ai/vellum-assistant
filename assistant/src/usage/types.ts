import type { UsageActor } from './actors.js';

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
  pricingStatus: 'priced' | 'unpriced';
}

/**
 * A persisted usage event, combining the original input with
 * storage metadata and resolved pricing.
 */
export interface UsageEvent extends UsageEventInput {
  id: string;
  createdAt: number;
  estimatedCostUsd: number | null;
  pricingStatus: 'priced' | 'unpriced';
}
