import type { ServerMessage, UsageStats } from './ipc-protocol.js';
import * as conversationStore from '../memory/conversation-store.js';
import { estimateCost, resolvePricingWithOverrides } from '../util/pricing.js';
import { recordUsageEvent } from '../memory/llm-usage-store.js';
import { getConfig } from '../config/loader.js';
import type { UsageActor } from '../usage/actors.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('session-usage');

export interface UsageContext {
  conversationId: string;
  providerName: string;
  usageStats: UsageStats;
}

export function recordUsage(
  ctx: UsageContext,
  inputTokens: number,
  outputTokens: number,
  model: string,
  onEvent: (msg: ServerMessage) => void,
  actor: UsageActor,
  requestId: string | null = null,
): void {
  if (inputTokens <= 0 && outputTokens <= 0) return;

  const estimatedCost = estimateCost(inputTokens, outputTokens, model, ctx.providerName);
  ctx.usageStats.inputTokens += inputTokens;
  ctx.usageStats.outputTokens += outputTokens;
  ctx.usageStats.estimatedCost += estimatedCost;

  conversationStore.updateConversationUsage(
    ctx.conversationId,
    ctx.usageStats.inputTokens,
    ctx.usageStats.outputTokens,
    ctx.usageStats.estimatedCost,
  );
  onEvent({
    type: 'usage_update',
    inputTokens,
    outputTokens,
    totalInputTokens: ctx.usageStats.inputTokens,
    totalOutputTokens: ctx.usageStats.outputTokens,
    estimatedCost,
    model,
  });

  // Dual-write: persist per-turn usage event to the new ledger table
  try {
    const config = getConfig();
    const pricing = resolvePricingWithOverrides(ctx.providerName, model, inputTokens, outputTokens, config.pricingOverrides);
    recordUsageEvent(
      {
        actor,
        provider: ctx.providerName,
        model,
        inputTokens,
        outputTokens,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
        conversationId: ctx.conversationId,
        runId: null,
        requestId,
      },
      pricing,
    );
  } catch (err) {
    log.warn({ err, conversationId: ctx.conversationId }, 'Failed to persist usage event (non-fatal)');
  }
}

