import { resolvePricing } from '../util/pricing.js';
import { recordUsageEvent } from '../memory/llm-usage-store.js';
import type { UsageActor } from './actors.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('usage-recorder');

/**
 * Raw usage object shape returned by the Anthropic SDK's `messages.create()`.
 */
export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/**
 * Context IDs to attach to a usage event.
 */
export interface UsageContext {
  assistantId?: string | null;
  conversationId?: string | null;
  runId?: string | null;
  requestId?: string | null;
}

/**
 * Record a usage event from a direct Anthropic SDK call.
 *
 * Resolves pricing and persists the event to the ledger.
 * Wrapped in try/catch so failures are non-fatal (logged as warnings).
 */
export function recordDirectLlmUsage(
  usage: AnthropicUsage,
  provider: string,
  model: string,
  actor: UsageActor,
  context?: UsageContext,
): void {
  try {
    const inputTokens = usage.input_tokens;
    const outputTokens = usage.output_tokens;

    if (inputTokens <= 0 && outputTokens <= 0) return;

    const pricing = resolvePricing(provider, model, inputTokens, outputTokens);
    recordUsageEvent(
      {
        actor,
        provider,
        model,
        inputTokens,
        outputTokens,
        cacheCreationInputTokens: usage.cache_creation_input_tokens ?? null,
        cacheReadInputTokens: usage.cache_read_input_tokens ?? null,
        assistantId: context?.assistantId ?? null,
        conversationId: context?.conversationId ?? null,
        runId: context?.runId ?? null,
        requestId: context?.requestId ?? null,
      },
      pricing,
    );
  } catch (err) {
    log.warn({ err, actor, model }, 'Failed to record LLM usage event (non-fatal)');
  }
}
