import type { AssistantEvent } from "../api/index.js";
import { getConfig } from "../config/loader.js";
import { updateConversationUsage } from "../persistence/conversation-crud.js";
import { recordUsageEvent } from "../persistence/llm-usage-store.js";
import type { UsageActor } from "../usage/actors.js";
import { resolveUsageAttribution } from "../usage/attribution.js";
import { extractRawUsage } from "../usage/pricing.js";
import type {
  AnthropicCacheCreationTokenDetails,
  PricingResult,
  PricingUsage,
  UsageAttributionInput,
  UsageAttributionSnapshot,
} from "../usage/types.js";
import { getLogger } from "../util/logger.js";
import {
  resolvePricingForUsageWithOverrides,
  usesAnthropicPricingRules,
} from "../util/pricing.js";
import {
  isRetryableSqliteError,
  withSqliteRetry,
} from "../util/sqlite-retry.js";
import type { UsageStats } from "./message-protocol.js";

const log = getLogger("conversation-usage");

export interface UsageContext {
  conversationId: string;
  providerName: string;
  usageStats: UsageStats;
}

function normalizeTokenCount(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(value, 0);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value == null) {
    return null;
  }
  return value as Record<string, unknown>;
}

function extractAnthropicCacheCreationFromResponse(
  response: unknown,
): AnthropicCacheCreationTokenDetails | null {
  const rawResponse = asRecord(response);
  const usage = asRecord(rawResponse?.usage);
  const cacheCreation = asRecord(usage?.cache_creation);
  if (!cacheCreation) {
    return null;
  }

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
    if (!details) {
      continue;
    }
    foundDetails = true;
    ephemeral5mInputTokens += normalizeTokenCount(
      details.ephemeral_5m_input_tokens,
    );
    ephemeral1hInputTokens += normalizeTokenCount(
      details.ephemeral_1h_input_tokens,
    );
  }

  if (!foundDetails) {
    return null;
  }

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
    if (usage?.speed === "fast") {
      return "fast";
    }
    if (usage?.speed === "standard") {
      foundStandard = true;
    }
  }
  return foundStandard ? "standard" : null;
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
      config.llm.pricingOverrides,
    );
  } catch (err) {
    log.warn({ err, model, providerName }, "Failed to resolve usage pricing");
    return { estimatedCostUsd: null, pricingStatus: "unpriced" };
  }
}

function isUsageAttributionSnapshot(
  attribution:
    | UsageAttributionInput
    | UsageAttributionSnapshot
    | null
    | undefined,
): attribution is UsageAttributionSnapshot {
  return (
    attribution != null &&
    typeof (attribution as UsageAttributionSnapshot).resolvedProvider ===
      "string" &&
    typeof (attribution as UsageAttributionSnapshot).resolvedModel === "string"
  );
}

function resolveAttribution(
  attribution:
    | UsageAttributionInput
    | UsageAttributionSnapshot
    | null
    | undefined,
): UsageAttributionSnapshot | null {
  if (attribution == null) {
    return null;
  }
  return isUsageAttributionSnapshot(attribution)
    ? attribution
    : resolveUsageAttribution(attribution);
}

interface PendingUsageWrite {
  /** Most recent context for this conversation; every attempt persists it. */
  latest: UsageContext;
  /** A usage event arrived while the chain was draining; one trailing write owed. */
  dirty: boolean;
}

const pendingUsageWrites = new Map<string, PendingUsageWrite>();

/**
 * Persist the conversation row's cumulative usage totals, tolerating SQLite
 * write contention. Usage accounting is post-turn bookkeeping — a concurrent
 * bulk writer (e.g. a retrospective fork copy) holding the write lock past
 * `busy_timeout` must never surface as a failed turn, so no error escapes.
 *
 * The first attempt runs synchronously (the common, uncontended path). On a
 * transient `SQLITE_BUSY`/`SQLITE_IOERR` it falls back to a background
 * {@link withSqliteRetry} chain, single-flight per conversation: events that
 * land mid-chain coalesce into one trailing write instead of racing it, so a
 * delayed retry can never overwrite newer totals with older ones. Totals are
 * absolute values read from the live {@link UsageStats} accumulator at
 * statement time, which makes coalescing lossless and a fully dropped write
 * self-healing on the next usage event.
 */
function persistUsageTotals(ctx: UsageContext): void {
  const pending = pendingUsageWrites.get(ctx.conversationId);
  if (pending) {
    pending.latest = ctx;
    pending.dirty = true;
    return;
  }
  try {
    writeUsageTotals(ctx);
    return;
  } catch (err) {
    if (!isRetryableSqliteError(err)) {
      log.warn(
        { err, conversationId: ctx.conversationId },
        "Failed to persist conversation usage totals (non-fatal)",
      );
      return;
    }
  }
  const entry: PendingUsageWrite = { latest: ctx, dirty: false };
  pendingUsageWrites.set(ctx.conversationId, entry);
  void retryUsageWrite(entry);
}

function writeUsageTotals(target: UsageContext): void {
  updateConversationUsage(
    target.conversationId,
    target.usageStats.inputTokens,
    target.usageStats.outputTokens,
    target.usageStats.estimatedCost,
  );
}

async function retryUsageWrite(entry: PendingUsageWrite): Promise<void> {
  const conversationId = entry.latest.conversationId;
  try {
    await withSqliteRetry(() => writeUsageTotals(entry.latest), {
      op: "conversation:updateUsage",
      context: { conversationId },
    });
  } catch (err) {
    log.warn(
      { err, conversationId },
      "Failed to persist conversation usage totals after retries; totals self-heal on the next usage event (non-fatal)",
    );
  } finally {
    pendingUsageWrites.delete(conversationId);
    if (entry.dirty) {
      persistUsageTotals(entry.latest);
    }
  }
}

export function recordUsage(
  ctx: UsageContext,
  inputTokens: number,
  outputTokens: number,
  model: string,
  onEvent: (msg: AssistantEvent) => void,
  actor: UsageActor,
  requestId: string | null = null,
  cacheCreationInputTokens = 0,
  cacheReadInputTokens = 0,
  rawResponse?: unknown,
  llmCallCount = 1,
  contextWindow?: { tokens: number; maxTokens: number },
  attribution?: UsageAttributionInput | UsageAttributionSnapshot | null,
  cronRunId: string | null = null,
): void {
  if (inputTokens <= 0 && outputTokens <= 0) {
    return;
  }

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

  const useAnthropicRules = usesAnthropicPricingRules(ctx.providerName, model);
  const pricingUsage: PricingUsage = {
    directInputTokens,
    outputTokens,
    cacheCreationInputTokens: normalizedCacheCreationInputTokens,
    cacheReadInputTokens: normalizedCacheReadInputTokens,
    anthropicCacheCreation: useAnthropicRules
      ? extractAnthropicCacheCreation(rawResponse)
      : null,
    speed: useAnthropicRules ? extractAnthropicSpeed(rawResponse) : null,
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

  // Normalize both sides: NaN passes the <=0 early-return above (NaN
  // comparisons are false) and binds as NULL in SQLite, and normalizing the
  // running total heals a counter already poisoned by a prior NaN.
  ctx.usageStats.inputTokens =
    normalizeTokenCount(ctx.usageStats.inputTokens) +
    normalizeTokenCount(inputTokens);
  ctx.usageStats.outputTokens =
    normalizeTokenCount(ctx.usageStats.outputTokens) +
    normalizeTokenCount(outputTokens);
  ctx.usageStats.estimatedCost =
    (Number.isFinite(ctx.usageStats.estimatedCost)
      ? ctx.usageStats.estimatedCost
      : 0) + estimatedCost;

  persistUsageTotals(ctx);
  onEvent({
    type: "usage_update",
    conversationId: ctx.conversationId,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens: normalizedCacheCreationInputTokens,
    cacheReadInputTokens: normalizedCacheReadInputTokens,
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
    const attributionSnapshot = resolveAttribution(attribution);
    recordUsageEvent(
      {
        actor,
        provider: ctx.providerName,
        model,
        inputTokens: directInputTokens,
        outputTokens,
        cacheCreationInputTokens: normalizedCacheCreationInputTokens,
        cacheReadInputTokens: normalizedCacheReadInputTokens,
        rawUsage: extractRawUsage(rawResponse),
        conversationId: ctx.conversationId,
        runId: null,
        cronRunId,
        requestId,
        llmCallCount,
        callSite: attributionSnapshot?.callSite ?? null,
        inferenceProfile: attributionSnapshot?.appliedProfile ?? null,
        inferenceProfileSource: attributionSnapshot?.profileSource ?? null,
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
