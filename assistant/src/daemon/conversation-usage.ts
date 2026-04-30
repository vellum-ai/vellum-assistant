import { updateConversationUsage } from "../memory/conversation-crud.js";
import { recordUsageEvent } from "../memory/llm-usage-store.js";
import type { UsageActor } from "../usage/actors.js";
import {
  buildPricingUsage,
  resolveStructuredPricing,
} from "../usage/pricing.js";
import { getLogger } from "../util/logger.js";
import type { ServerMessage, UsageStats } from "./message-protocol.js";

const log = getLogger("conversation-usage");

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
  cacheCreationInputTokens = 0,
  cacheReadInputTokens = 0,
  rawResponse?: unknown,
  llmCallCount = 1,
  contextWindow?: { tokens: number; maxTokens: number },
): void {
  if (inputTokens <= 0 && outputTokens <= 0) return;

  const pricingUsage = buildPricingUsage({
    providerName: ctx.providerName,
    model,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    rawResponse,
  });
  const pricing = resolveStructuredPricing(
    ctx.providerName,
    model,
    pricingUsage,
  );
  const estimatedCost =
    pricing.pricingStatus === "priced" && pricing.estimatedCostUsd != null
      ? pricing.estimatedCostUsd
      : 0;

  ctx.usageStats.inputTokens += inputTokens;
  ctx.usageStats.outputTokens += outputTokens;
  ctx.usageStats.estimatedCost += estimatedCost;

  updateConversationUsage(
    ctx.conversationId,
    ctx.usageStats.inputTokens,
    ctx.usageStats.outputTokens,
    ctx.usageStats.estimatedCost,
  );
  onEvent({
    type: "usage_update",
    conversationId: ctx.conversationId,
    inputTokens,
    outputTokens,
    totalInputTokens: ctx.usageStats.inputTokens,
    totalOutputTokens: ctx.usageStats.outputTokens,
    estimatedCost,
    model,
    ...(contextWindow && {
      contextWindowTokens: contextWindow.tokens,
      contextWindowMaxTokens: contextWindow.maxTokens,
    }),
  });

  // Dual-write: persist per-turn usage event to the new ledger table
  try {
    recordUsageEvent(
      {
        actor,
        provider: ctx.providerName,
        model,
        inputTokens: pricingUsage.directInputTokens,
        outputTokens,
        cacheCreationInputTokens: pricingUsage.cacheCreationInputTokens,
        cacheReadInputTokens: pricingUsage.cacheReadInputTokens,
        conversationId: ctx.conversationId,
        runId: null,
        requestId,
        llmCallCount,
      },
      pricing,
    );
  } catch (err) {
    log.warn(
      { err, conversationId: ctx.conversationId },
      "Failed to persist usage event (non-fatal)",
    );
  }
}
