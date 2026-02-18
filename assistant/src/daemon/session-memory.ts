import type { Message } from '../providers/types.js';
import type { ServerMessage } from './ipc-protocol.js';
import type { Provider } from '../providers/types.js';
import { getConfig } from '../config/loader.js';
import {
  buildMemoryRecall,
  injectMemoryRecallIntoUserMessage,
  injectMemoryRecallAsSeparateMessage,
} from '../memory/retriever.js';
import type { ScopePolicyOverride } from '../memory/search/types.js';
import { buildMemoryQuery } from '../memory/query-builder.js';
import { computeRecallBudget } from '../memory/retrieval-budget.js';
import { estimatePromptTokens } from '../context/token-estimator.js';
import { compileDynamicProfile } from '../memory/profile-compiler.js';
import { getMemoryConflictAndCleanupStats } from '../memory/admin.js';
import type { ConflictGate } from './session-conflict-gate.js';
import { injectDynamicProfileIntoUserMessage } from './session-dynamic-profile.js';

export type RecallInjectionStrategy = 'prepend_user_block' | 'separate_context_message';

export interface MemoryRecallResult {
  runMessages: Message[];
  recall: Awaited<ReturnType<typeof buildMemoryRecall>>;
  dynamicProfile: { text: string };
  softConflictInstruction: string | null;
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
): Promise<MemoryRecallResult & { conflictClarification: string | null }> {
  const runtimeConfig = getConfig();
  const memoryEnabled = runtimeConfig.memory?.enabled !== false;

  // Conflict gate
  const conflictConfig = memoryEnabled ? runtimeConfig.memory?.conflicts : undefined;
  const conflictGateResult = conflictConfig
    ? await ctx.conflictGate.evaluate(content, conflictConfig, ctx.scopeId)
    : null;

  if (conflictGateResult?.relevant) {
    return {
      runMessages: ctx.messages,
      recall: {
        enabled: false,
        degraded: false,
        injectedText: '',
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
      dynamicProfile: { text: '' },
      softConflictInstruction: null,
      recallInjectionStrategy: 'prepend_user_block',
      conflictClarification: [
        conflictGateResult.question,
        '',
        'I need this clarification before I can give guidance that depends on that preference.',
      ].join('\n'),
    };
  }

  const softConflictInstruction = conflictGateResult && !conflictGateResult.relevant
    ? conflictGateResult.question
    : null;

  // Dynamic profile
  const profileConfig = memoryEnabled ? runtimeConfig.memory?.profile : undefined;
  const dynamicProfile = profileConfig?.enabled
    ? compileDynamicProfile({
        scopeId: ctx.scopeId,
        includeDefaultFallback: ctx.includeDefaultFallback,
        maxInjectTokensOverride: profileConfig.maxInjectTokens,
      })
    : { text: '' };

  // Memory recall
  const recallQuery = buildMemoryQuery(content, ctx.messages);
  const recallInjectionStrategy: RecallInjectionStrategy = (runtimeConfig.memory?.retrieval?.injectionStrategy as RecallInjectionStrategy | undefined) ?? 'prepend_user_block';
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
    ctx.scopeId !== 'default'
      ? { scopeId: ctx.scopeId, fallbackToDefault: ctx.includeDefaultFallback }
      : undefined;

  const recall = await buildMemoryRecall(recallQuery, ctx.conversationId, runtimeConfig, {
    excludeMessageIds: [userMessageId],
    signal: abortSignal,
    maxInjectTokensOverride: recallBudget,
    scopeId: ctx.scopeId,
    scopePolicyOverride,
  });
  const memoryStatus = getMemoryConflictAndCleanupStats();

  onEvent({
    type: 'memory_status',
    enabled: recall.enabled,
    degraded: recall.degraded,
    reason: recall.reason,
    provider: recall.provider,
    model: recall.model,
    conflictsPending: memoryStatus.conflicts.pending,
    conflictsResolved: memoryStatus.conflicts.resolved,
    oldestPendingConflictAgeMs: memoryStatus.conflicts.oldestPendingAgeMs,
    cleanupResolvedJobsPending: memoryStatus.cleanup.resolvedBacklog,
    cleanupSupersededJobsPending: memoryStatus.cleanup.supersededBacklog,
    cleanupResolvedJobsCompleted24h: memoryStatus.cleanup.resolvedCompleted24h,
    cleanupSupersededJobsCompleted24h: memoryStatus.cleanup.supersededCompleted24h,
  });

  // Inject recall into messages
  let runMessages = ctx.messages;
  if (recall.injectedText.length > 0) {
    const userTail = ctx.messages[ctx.messages.length - 1];
    if (userTail && userTail.role === 'user') {
      if (recallInjectionStrategy === 'separate_context_message') {
        runMessages = injectMemoryRecallAsSeparateMessage(ctx.messages, recall.injectedText);
      } else {
        runMessages = [
          ...ctx.messages.slice(0, -1),
          injectMemoryRecallIntoUserMessage(userTail, recall.injectedText),
        ];
      }
      onEvent({
        type: 'memory_recalled',
        provider: recall.provider ?? 'unknown',
        model: recall.model ?? 'unknown',
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
    if (userTail && userTail.role === 'user') {
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
    softConflictInstruction,
    recallInjectionStrategy,
    conflictClarification: null,
  };
}
