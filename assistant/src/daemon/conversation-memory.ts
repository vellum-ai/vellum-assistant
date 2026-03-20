import { getConfig } from "../config/loader.js";
import { estimatePromptTokens } from "../context/token-estimator.js";
import { buildArchiveRecall } from "../memory/archive-recall.js";
import { compileMemoryBrief } from "../memory/brief.js";
import { getDb } from "../memory/db.js";
import { buildMemoryQuery } from "../memory/query-builder.js";
import { computeRecallBudget } from "../memory/retrieval-budget.js";
import {
  buildMemoryRecall,
  injectMemoryRecallAsUserBlock,
} from "../memory/retriever.js";
import type { ScopePolicyOverride } from "../memory/search/types.js";
import type { Message } from "../providers/types.js";
import type { Provider } from "../providers/types.js";
import { getLogger } from "../util/logger.js";
import type { ServerMessage } from "./message-protocol.js";

const log = getLogger("conversation-memory");

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
 * retrieval. Returns `false` for mechanical no-ops (empty content,
 * tool-result-only) so the full memory pipeline can be skipped.
 * Runs in microseconds — no external calls.
 *
 * Note: We intentionally avoid character-length heuristics here.
 * Short messages like "What did I say?" or "My preferences?" are
 * legitimate memory queries. Per AGENTS.md, judgement calls about
 * message value should be routed through the daemon, not hardcoded.
 */
export function needsMemory(messages: Message[], content: string): boolean {
  // Empty or whitespace-only content — mechanical validation, nothing to query
  if (!content || content.trim().length === 0) return false;

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
 * Memory context is injected as a text content block prepended to the
 * last user message (same pattern as workspace/temporal injections).
 * Stripping is handled by `stripUserTextBlocksByPrefix` matching the
 * `<memory_context __injected>` prefix in `RUNTIME_INJECTION_PREFIXES`.
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

  // Gate: skip the entire memory pipeline for mechanical no-ops (empty
  // content, tool-result-only turns).
  if (!needsMemory(ctx.messages, content)) {
    return noopResult();
  }

  const runtimeConfig = getConfig();

  // ── Simplified memory path ──────────────────────────────────────────
  // When `memory.simplified.enabled` is true, inject the brief and
  // optional archive recall instead of the legacy hybrid pipeline.
  if (runtimeConfig.memory?.simplified?.enabled) {
    return prepareSimplifiedMemoryContext(ctx, content, userMessageId, onEvent);
  }

  // ── Legacy memory path (fallback) ──────────────────────────────────
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
  // honours the conversation's memory policy regardless of the global config.
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

  // Inject recall as a text block prepended to the last user message.
  // When injection text is empty, skip injection entirely.
  let runMessages = ctx.messages;
  if (recall.injectedText.length > 0) {
    const userTail = ctx.messages[ctx.messages.length - 1];
    if (userTail && userTail.role === "user") {
      runMessages = injectMemoryRecallAsUserBlock(
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

// ── Simplified memory injection ─────────────────────────────────────────

/**
 * Build simplified memory context for a turn: compiles the `<memory_brief>`
 * block and conditionally appends `<supporting_recall>` from the archive.
 *
 * Non-empty blocks are injected as text content blocks prepended to the
 * last user message, following the same injection pattern as the legacy
 * pipeline. Stripping is handled by `RUNTIME_INJECTION_PREFIXES` which
 * already includes `<memory_brief>`.
 */
function prepareSimplifiedMemoryContext(
  ctx: MemoryPrepareContext,
  content: string,
  userMessageId: string,
  onEvent: (msg: ServerMessage) => void,
): MemoryRecallResult {
  const start = Date.now();

  // Build a no-op recall result matching the legacy shape.
  const noopRecall = (): Awaited<ReturnType<typeof buildMemoryRecall>> =>
    ({
      enabled: true,
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
    }) as Awaited<ReturnType<typeof buildMemoryRecall>>;

  try {
    const db = getDb();

    // Step 1: Build the memory brief
    const briefResult = compileMemoryBrief(db, ctx.scopeId, userMessageId);

    // Step 2: Conditionally build supporting recall from the archive
    const archiveResult = buildArchiveRecall(ctx.scopeId, content);

    // Step 3: Assemble the injection blocks (non-empty only)
    const blocks: string[] = [];
    if (briefResult.text.length > 0) {
      blocks.push(briefResult.text);
    }
    if (archiveResult.text.length > 0) {
      blocks.push(archiveResult.text);
    }

    const latencyMs = Date.now() - start;

    // Emit memory status for the simplified path
    onEvent({
      type: "memory_status",
      enabled: true,
      degraded: false,
    });

    // Inject non-empty blocks into the last user message
    let runMessages = ctx.messages;
    if (blocks.length > 0) {
      const injectedText = blocks.join("\n\n");
      const userTail = ctx.messages[ctx.messages.length - 1];
      if (userTail && userTail.role === "user") {
        runMessages = injectMemoryRecallAsUserBlock(ctx.messages, injectedText);
      }

      log.debug(
        {
          briefLength: briefResult.text.length,
          recallTrigger: archiveResult.trigger,
          recallBullets: archiveResult.bullets.length,
          latencyMs,
        },
        "Simplified memory injection completed",
      );
    }

    return {
      runMessages,
      recall: {
        ...noopRecall(),
        injectedText: blocks.length > 0 ? blocks.join("\n\n") : "",
        latencyMs,
      },
    };
  } catch (err) {
    log.warn({ err }, "Simplified memory injection failed, returning no-op");
    return {
      runMessages: ctx.messages,
      recall: {
        ...noopRecall(),
        latencyMs: Date.now() - start,
      },
    };
  }
}
