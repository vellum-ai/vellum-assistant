import Anthropic from '@anthropic-ai/sdk';
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
  assistantId: string | null;
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
        assistantId: ctx.assistantId,
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

export async function generateTitle(conversationId: string, userMessage: string, assistantResponse: string): Promise<void> {
  const config = getConfig();
  const apiKey = config.apiKeys.anthropic ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return;

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 20,
    messages: [{
      role: 'user',
      content: `Generate a very short title for this conversation. Rules: at most 5 words, at most 40 characters, no quotes.\n\nUser: ${userMessage.slice(0, 200)}\nAssistant: ${assistantResponse.slice(0, 200)}`,
    }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (textBlock && textBlock.type === 'text') {
    let title = textBlock.text.trim().replace(/^["']|["']$/g, '');
    const words = title.split(/\s+/);
    if (words.length > 5) title = words.slice(0, 5).join(' ');
    if (title.length > 40) title = title.slice(0, 40).trimEnd();
    conversationStore.updateConversationTitle(conversationId, title);
    log.info({ conversationId, title }, 'Auto-generated conversation title');
  }
}
