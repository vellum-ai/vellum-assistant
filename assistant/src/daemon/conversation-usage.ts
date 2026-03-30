import { getConfig } from "../config/loader.js";
import { updateConversationUsage } from "../memory/conversation-crud.js";
import { recordUsageEvent } from "../memory/llm-usage-store.js";
import type { UsageActor } from "../usage/actors.js";
import type {
  AnthropicCacheCreationTokenDetails,
  PricingResult,
  PricingUsage,
} from "../usage/types.js";
import { getLogger } from "../util/logger.js";
import { resolvePricingForUsageWithOverrides } from "../util/pricing.js";
import type { ServerMessage, UsageStats } from "./message-protocol.js";

const log = getLogger("conversation-usage");

export interface UsageContext {
  conversationId: string;
  providerName: string;
  usageStats: UsageStats;
}

function normalizeTokenCount(value: number | null | undefined): number {
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
  for (const response of responses) {
    const rec = asRecord(response);
    const usage = asRecord(rec?.usage);
    if (usage?.speed === "fast") return "fast";
    if (usage?.speed === "standard") return "standard";
  }
  return null;
}

function resolveStructuredPricing(
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
      config.pricingOverrides,
    );
  } catch (err) {
    log.warn({ err, model, providerName }, "Failed to resolve usage pricing");
    return { estimatedCostUsd: null, pricingStatus: "unpriced" };
  }
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
): void {
  if (inputTokens <= 0 && outputTokens <= 0) return;

  const normalizedCacheCreationInputTokens = normalizeTokenCount(
    cacheCreationInputTokens,
  );
  const normalizedCacheReadInputTokens =
    normalizeTokenCount(cacheReadInputTokens);
  const directInputTokens = Math.max(
    normalizeTokenCount(inputTokens) -
      normalizedCacheCreationInputTokens -
      normalizedCacheReadInputTokens,
    0,
  );

  const isAnthropic = ctx.providerName === "anthropic";
  const pricingUsage: PricingUsage = {
    directInputTokens,
    outputTokens,
    cacheCreationInputTokens: normalizedCacheCreationInputTokens,
    cacheReadInputTokens: normalizedCacheReadInputTokens,
    anthropicCacheCreation: isAnthropic
      ? extractAnthropicCacheCreation(rawResponse)
      : null,
    speed: isAnthropic ? extractAnthropicSpeed(rawResponse) : null,
  };
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
    inputTokens,
    outputTokens,
    totalInputTokens: ctx.usageStats.inputTokens,
    totalOutputTokens: ctx.usageStats.outputTokens,
    estimatedCost,
    model,
  });

  // Dual-write: persist per-turn usage event to the new ledger table
  try {
    recordUsageEvent(
      {
        actor,
        provider: ctx.providerName,
        model,
        inputTokens: directInputTokens,
        outputTokens,
        cacheCreationInputTokens: normalizedCacheCreationInputTokens,
        cacheReadInputTokens: normalizedCacheReadInputTokens,
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
