import { getConfig } from "../config/loader.js";
import { estimatePromptTokens } from "../context/token-estimator.js";
import { getMemoryConflictAndCleanupStats } from "../memory/admin.js";
import { compileDynamicProfile } from "../memory/profile-compiler.js";
import { buildMemoryQuery } from "../memory/query-builder.js";
import { computeRecallBudget } from "../memory/retrieval-budget.js";
import {
  buildMemoryRecall,
  injectMemoryRecallAsSeparateMessage,
  injectMemoryRecallIntoUserMessage,
} from "../memory/retriever.js";
import type { ScopePolicyOverride } from "../memory/search/types.js";
import type { Message } from "../providers/types.js";
import type { Provider } from "../providers/types.js";
import type { ServerMessage } from "./message-protocol.js";
import type { ConflictGate } from "./session-conflict-gate.js";
import { injectDynamicProfileIntoUserMessage } from "./session-dynamic-profile.js";

export type RecallInjectionStrategy =
  | "prepend_user_block"
  | "separate_context_message";

export interface MemoryRecallResult {
  runMessages: Message[];
  recall: Awaited<ReturnType<typeof buildMemoryRecall>>;
  dynamicProfile: { text: string };
  recallInjectionStrategy: RecallInjectionStrategy;
}

export interface MemoryPrepareContext {
  conversationId: string;
  messages: Message[];
  systemPrompt: string;
  provider: Provider;
  conflictGate: ConflictGate;
  scopeId: string;
  includeDefaultFallback: boolean;
  trustClass: "guardian" | "trusted_contact" | "unknown";
  /** When false (e.g. scheduled tasks), skip conflict gate evaluation. */
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
    message.content.every((block) => block.type === "tool_result")
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
 * Build memory recall, dynamic profile, and conflict gate evaluation
 * for a single agent loop turn. Returns the augmented run messages and
 * metadata for downstream event emission.
 */
export async function prepareMemoryContext(
  ctx: MemoryPrepareContext,
  content: string,
  userMessageId: string,
  abortSignal: AbortSignal,
  onEvent: (msg: ServerMessage) => void,
): Promise<MemoryRecallResult> {
  // Provenance-based trust gating: untrusted actors skip all memory operations
  // (recall, dynamic profile, conflict gate) to prevent untrusted content from
  // influencing memory-augmented responses.
  const isTrustedActor = ctx.trustClass === "guardian";

  // Build a no-op result that skips the entire memory pipeline.
  const noopResult = (): MemoryRecallResult => ({
    runMessages: ctx.messages,
    recall: {
      enabled: false,
      degraded: false,
      injectedText: "",
      lexicalHits: 0,
      semanticHits: 0,
      recencyHits: 0,
      entityHits: 0,
      relationSeedEntityCount: 0,
      relationTraversedEdgeCount: 0,
      relationNeighborEntityCount: 0,
      relationExpandedItemCount: 0,
      earlyTerminated: false,
      mergedCount: 0,
      selectedCount: 0,
      rerankApplied: false,
      injectedTokens: 0,
      latencyMs: 0,
      topCandidates: [],
    } as Awaited<ReturnType<typeof buildMemoryRecall>>,
    dynamicProfile: { text: "" },
    recallInjectionStrategy: "prepend_user_block",
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
  const memoryEnabled = runtimeConfig.memory?.enabled !== false;

  // Conflict gate — evaluate for side effects (background resolution/dismissal)
  // but do not return any user-facing payload. Non-interactive sessions skip
  // entirely since there is no human context for conflict evaluation.
  const isInteractive = ctx.isInteractive !== false;
  const conflictConfig =
    memoryEnabled && isInteractive
      ? runtimeConfig.memory?.conflicts
      : undefined;
  if (conflictConfig) {
    await ctx.conflictGate.evaluate(content, conflictConfig, ctx.scopeId);
  }

  // Dynamic profile
  const profileConfig = memoryEnabled
    ? runtimeConfig.memory?.profile
    : undefined;
  const dynamicProfile = profileConfig?.enabled
    ? compileDynamicProfile({
        scopeId: ctx.scopeId,
        includeDefaultFallback: ctx.includeDefaultFallback,
        maxInjectTokensOverride: profileConfig.maxInjectTokens,
      })
    : { text: "" };

  // Memory recall
  const recallQuery = buildMemoryQuery(content, ctx.messages);
  const recallInjectionStrategy: RecallInjectionStrategy =
    (runtimeConfig.memory?.retrieval?.injectionStrategy as
      | RecallInjectionStrategy
      | undefined) ?? "prepend_user_block";
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
  const memoryStatus = getMemoryConflictAndCleanupStats();

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
    conflictsPending: memoryStatus.conflicts.pending,
    conflictsResolved: memoryStatus.conflicts.resolved,
    oldestPendingConflictAgeMs: memoryStatus.conflicts.oldestPendingAgeMs,
    cleanupResolvedJobsPending: memoryStatus.cleanup.resolvedBacklog,
    cleanupSupersededJobsPending: memoryStatus.cleanup.supersededBacklog,
    cleanupResolvedJobsCompleted24h: memoryStatus.cleanup.resolvedCompleted24h,
    cleanupSupersededJobsCompleted24h:
      memoryStatus.cleanup.supersededCompleted24h,
  });

  // Inject recall into messages
  let runMessages = ctx.messages;
  if (recall.injectedText.length > 0) {
    const userTail = ctx.messages[ctx.messages.length - 1];
    if (userTail && userTail.role === "user") {
      if (recallInjectionStrategy === "separate_context_message") {
        runMessages = injectMemoryRecallAsSeparateMessage(
          ctx.messages,
          recall.injectedText,
        );
      } else {
        runMessages = [
          ...ctx.messages.slice(0, -1),
          injectMemoryRecallIntoUserMessage(userTail, recall.injectedText),
        ];
      }
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
        lexicalHits: recall.lexicalHits,
        semanticHits: recall.semanticHits,
        recencyHits: recall.recencyHits,
        entityHits: recall.entityHits,
        relationSeedEntityCount: recall.relationSeedEntityCount,
        relationTraversedEdgeCount: recall.relationTraversedEdgeCount,
        relationNeighborEntityCount: recall.relationNeighborEntityCount,
        relationExpandedItemCount: recall.relationExpandedItemCount,
        earlyTerminated: recall.earlyTerminated,
        mergedCount: recall.mergedCount,
        selectedCount: recall.selectedCount,
        rerankApplied: recall.rerankApplied,
        injectedTokens: recall.injectedTokens,
        latencyMs: recall.latencyMs,
        topCandidates: recall.topCandidates,
      });
    }
  }

  // Inject dynamic profile
  if (dynamicProfile.text.length > 0) {
    const userTail = runMessages[runMessages.length - 1];
    if (userTail && userTail.role === "user") {
      runMessages = [
        ...runMessages.slice(0, -1),
        injectDynamicProfileIntoUserMessage(userTail, dynamicProfile.text),
      ];
    }
  }

  return {
    runMessages,
    recall,
    dynamicProfile,
    recallInjectionStrategy,
  };
}
