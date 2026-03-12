import { getConfig } from "../config/loader.js";
import { estimatePromptTokens } from "../context/token-estimator.js";
import { buildMemoryQuery } from "../memory/query-builder.js";
import { computeRecallBudget } from "../memory/retrieval-budget.js";
import {
  buildMemoryRecall,
  injectMemoryRecallAsSeparateMessage,
} from "../memory/retriever.js";
import type { ScopePolicyOverride } from "../memory/search/types.js";
import type { Message } from "../providers/types.js";
import type { Provider } from "../providers/types.js";
import type { ServerMessage } from "./message-protocol.js";

export interface MemoryRecallResult {
  runMessages: Message[];
  recall: Awaited<ReturnType<typeof buildMemoryRecall>>;
}

export interface MemoryPrepareContext {
  conversationId: string;
  messages: Message[];
  systemPrompt: string;
  provider: Provider;
  scopeId: string;
  includeDefaultFallback: boolean;
  trustClass: "guardian" | "trusted_contact" | "unknown";
  /** When false (e.g. scheduled tasks), skip memory retrieval. */
  isInteractive?: boolean;
}

/**
 * Returns true when the latest user turn is an internal tool-result-only
 * message (no user-authored text/image content).
 */
function isToolResultOnlyUserTurn(message: Message | undefined): boolean {
  return (
    message?.role === "user" &&
    message.content.length > 0 &&
    message.content.every(
      (block) =>
        block.type === "tool_result" || block.type === "web_search_tool_result",
    )
  );
}

/**
 * Fast gate that determines whether the current turn warrants memory
 * retrieval. Returns `false` for low-value turns (empty, very short,
 * tool-result-only) so the full memory pipeline can be skipped.
 * Runs in microseconds — string length checks only, no external calls.
 */
export function needsMemory(messages: Message[], content: string): boolean {
  // Empty or whitespace-only content
  if (!content || content.trim().length === 0) return false;

  // Very short messages like "ok", "thanks", "yes"
  if (content.length < 20) return false;

  // Tool-result-only turns (assistant tool loop)
  const latestMessage = messages[messages.length - 1];
  if (isToolResultOnlyUserTurn(latestMessage)) return false;

  return true;
}

/**
 * Build memory recall for a single agent loop turn using the V2 hybrid
 * pipeline. Returns the augmented run messages and metadata for
 * downstream event emission.
 *
 * The V2 pipeline always uses `separate_context_message` injection
 * strategy (user + assistant ack pair). When injection text is empty,
 * no synthetic messages are added.
 */
export async function prepareMemoryContext(
  ctx: MemoryPrepareContext,
  content: string,
  userMessageId: string,
  abortSignal: AbortSignal,
  onEvent: (msg: ServerMessage) => void,
): Promise<MemoryRecallResult> {
  // Provenance-based trust gating: untrusted actors skip all memory operations
  // to prevent untrusted content from influencing memory-augmented responses.
  const isTrustedActor = ctx.trustClass === "guardian";

  // Build a no-op result that skips the entire memory pipeline.
  const noopResult = (): MemoryRecallResult => ({
    runMessages: ctx.messages,
    recall: {
      enabled: false,
      degraded: false,
      injectedText: "",
      semanticHits: 0,
      recencyHits: 0,
      mergedCount: 0,
      selectedCount: 0,
      injectedTokens: 0,
      latencyMs: 0,
      topCandidates: [],
      tier1Count: 0,
      tier2Count: 0,
    } as Awaited<ReturnType<typeof buildMemoryRecall>>,
  });

  if (!isTrustedActor) {
    return noopResult();
  }

  // Gate: skip the entire memory pipeline for low-value turns (empty,
  // very short messages, tool-result-only turns).
  if (!needsMemory(ctx.messages, content)) {
    return noopResult();
  }

  const runtimeConfig = getConfig();

  // Memory recall via the V2 hybrid pipeline
  const recallQuery = buildMemoryQuery(content, ctx.messages);
  const dynamicBudgetConfig = runtimeConfig.memory?.retrieval?.dynamicBudget;
  const recallBudget = dynamicBudgetConfig?.enabled
    ? computeRecallBudget({
        estimatedPromptTokens: estimatePromptTokens(
          ctx.messages,
          ctx.systemPrompt,
          { providerName: ctx.provider.name },
        ),
        maxInputTokens: runtimeConfig.contextWindow.maxInputTokens,
        targetHeadroomTokens: dynamicBudgetConfig.targetHeadroomTokens,
        minInjectTokens: dynamicBudgetConfig.minInjectTokens,
        maxInjectTokens: dynamicBudgetConfig.maxInjectTokens,
      })
    : undefined;
  // Build scope policy override for non-default scopes so retrieval
  // honours the session's memory policy regardless of the global config.
  const scopePolicyOverride: ScopePolicyOverride | undefined =
    ctx.scopeId !== "default"
      ? { scopeId: ctx.scopeId, fallbackToDefault: ctx.includeDefaultFallback }
      : undefined;

  const recall = await buildMemoryRecall(
    recallQuery,
    ctx.conversationId,
    runtimeConfig,
    {
      excludeMessageIds: [userMessageId],
      signal: abortSignal,
      maxInjectTokensOverride: recallBudget,
      scopeId: ctx.scopeId,
      scopePolicyOverride,
    },
  );
  onEvent({
    type: "memory_status",
    enabled: recall.enabled,
    degraded: recall.degraded,
    degradation: recall.degradation
      ? {
          semanticUnavailable: recall.degradation.semanticUnavailable,
          reason: recall.degradation.reason,
          fallbackSources: [...recall.degradation.fallbackSources],
        }
      : undefined,
    reason: recall.reason,
    provider: recall.provider,
    model: recall.model,
  });

  // Inject recall into messages using separate_context_message strategy.
  // When injection text is empty, skip injection entirely (no synthetic messages).
  let runMessages = ctx.messages;
  if (recall.injectedText.length > 0) {
    const userTail = ctx.messages[ctx.messages.length - 1];
    if (userTail && userTail.role === "user") {
      runMessages = injectMemoryRecallAsSeparateMessage(
        ctx.messages,
        recall.injectedText,
      );
      onEvent({
        type: "memory_recalled",
        provider: recall.provider ?? "unknown",
        model: recall.model ?? "unknown",
        degradation: recall.degradation
          ? {
              semanticUnavailable: recall.degradation.semanticUnavailable,
              reason: recall.degradation.reason,
              fallbackSources: [...recall.degradation.fallbackSources],
            }
          : undefined,
        semanticHits: recall.semanticHits,
        recencyHits: recall.recencyHits,
        tier1Count: recall.tier1Count ?? 0,
        tier2Count: recall.tier2Count ?? 0,
        hybridSearchLatencyMs: recall.hybridSearchMs ?? 0,
        sparseVectorUsed: recall.sparseVectorUsed ?? false,
        mergedCount: recall.mergedCount,
        selectedCount: recall.selectedCount,
        injectedTokens: recall.injectedTokens,
        latencyMs: recall.latencyMs,
        topCandidates: recall.topCandidates,
      });
    }
  }

  return {
    runMessages,
    recall,
  };
}
