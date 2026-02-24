import { inArray } from 'drizzle-orm';
import type { AssistantConfig } from '../config/types.js';
import { estimateTextTokens } from '../context/token-estimator.js';
import { getLogger } from '../util/logger.js';
import { embedWithBackend, getMemoryBackendStatus, logMemoryEmbeddingWarning } from './embedding-backend.js';
import { getDb } from './db.js';
import { memoryItemSources } from './schema.js';
import type {
  Candidate,
  CollectedCandidates,
  MemoryRecallCandiateDebug,
  MemoryRecallOptions,
  MemoryRecallResult,
  MemorySearchResult,
  ScopePolicyOverride,
} from './search/types.js';
import { lexicalSearch, recencySearch, directItemSearch } from './search/lexical.js';
import { semanticSearch, isQdrantConnectionError } from './search/semantic.js';
import { entitySearch } from './search/entity.js';
import { mergeCandidates, applySourceCaps, rerankWithLLM, trimToTokenBudget, markItemUsage } from './search/ranking.js';
import { buildInjectedText, MEMORY_CONTEXT_ACK } from './search/formatting.js';
import { getCachedRecall, setCachedRecall, getMemoryVersion } from './recall-cache.js';

// Re-export public types and functions so existing importers continue to work
export type {
  MemoryRecallCandiateDebug,
  MemoryRecallResult,
  MemorySearchResult,
  ScopePolicyOverride,
} from './search/types.js';
export {
  escapeXmlTags,
  formatAbsoluteTime,
  formatRelativeTime,
} from './search/formatting.js';

const log = getLogger('memory-retriever');

/**
 * Build the list of scope IDs to include in queries.
 * - If a `scopePolicyOverride` is provided, it takes precedence over both
 *   `scopeId` and `scopePolicy` — the override's `scopeId` is used as the
 *   primary scope and `fallbackToDefault` controls whether 'default' is
 *   included.
 * - If no scopeId is provided, returns undefined (no filtering).
 * - If scopePolicy is 'allow_global_fallback', includes both the
 *   requested scope and the 'default' scope.
 * - If scopePolicy is 'strict', only includes the requested scope.
 */
function buildScopeFilter(
  scopeId: string | undefined,
  scopePolicy: string,
  scopePolicyOverride?: ScopePolicyOverride,
): string[] | undefined {
  // Per-call override takes precedence over global config
  if (scopePolicyOverride) {
    const primary = scopePolicyOverride.scopeId;
    if (scopePolicyOverride.fallbackToDefault && primary !== 'default') {
      return [primary, 'default'];
    }
    return [primary];
  }

  if (!scopeId) return undefined;
  if (scopePolicy === 'allow_global_fallback') {
    return scopeId === 'default' ? ['default'] : [scopeId, 'default'];
  }
  return [scopeId];
}

/**
 * Shared retrieval pipeline: collect candidates from all available sources
 * (lexical, recency, semantic, entity, direct item search) and merge them
 * using RRF. Used by both `buildMemoryRecall()` (auto recall) and
 * `searchMemoryItems()` (memory_search tool) for consistent behavior.
 */
async function collectAndMergeCandidates(
  query: string,
  config: AssistantConfig,
  opts?: {
    queryVector?: number[] | null;
    provider?: string;
    model?: string;
    conversationId?: string;
    excludeMessageIds?: string[];
    scopeId?: string;
    scopePolicyOverride?: ScopePolicyOverride;
  },
): Promise<CollectedCandidates> {
  const queryVector = opts?.queryVector ?? null;
  const excludeMessageIds = opts?.excludeMessageIds ?? [];
  const scopeId = opts?.scopeId;
  const scopePolicy = config.memory.retrieval.scopePolicy;
  // Build the list of scope IDs to include in queries.
  // A per-call scopePolicyOverride takes precedence over the global policy.
  const scopeIds = buildScopeFilter(scopeId, scopePolicy, opts?.scopePolicyOverride);

  // -- Phase 1: cheap local searches (always run) --
  const lexical = lexicalSearch(query, config.memory.retrieval.lexicalTopK, excludeMessageIds, scopeIds);

  const recency = opts?.conversationId
    ? recencySearch(
        opts.conversationId,
        Math.max(10, Math.floor(config.memory.retrieval.semanticTopK / 2)),
        excludeMessageIds,
        scopeIds,
      )
    : [];

  // Direct item search supplements FTS with LIKE-based matching.
  // When exclusions are present, adaptively increase the fetch size until
  // we collect directLimit valid (non-excluded) items or exhaust the DB.
  const directLimit = Math.max(10, config.memory.retrieval.lexicalTopK);

  // Helper: filter fetched direct items to those with at least one non-excluded source.
  const filterDirectItems = (items: Candidate[]): Candidate[] => {
    if (items.length === 0) return items;
    const db = getDb();
    const excludedSet = new Set(excludeMessageIds);
    const allSources = db.select({
      memoryItemId: memoryItemSources.memoryItemId,
      messageId: memoryItemSources.messageId,
    }).from(memoryItemSources)
      .where(inArray(memoryItemSources.memoryItemId, items.map((c) => c.id)))
      .all();
    const hasNonExcluded = new Set<string>();
    const hasSources = new Set<string>();
    for (const s of allSources) {
      hasSources.add(s.memoryItemId);
      if (!excludedSet.has(s.messageId)) {
        hasNonExcluded.add(s.memoryItemId);
      }
    }
    return items.filter((c) => !hasSources.has(c.id) || hasNonExcluded.has(c.id));
  };

  let directItems: Candidate[];
  if (excludeMessageIds.length > 0) {
    // Adaptive loop: double fetch size on each iteration until quota met or DB exhausted.
    const MAX_FETCH_MULTIPLIER = 8;
    let fetchSize = Math.max(directLimit * 2, directLimit + 24);
    directItems = [];
    while (true) {
      const fetched = directItemSearch(query, fetchSize, scopeIds);
      directItems = filterDirectItems(fetched).slice(0, directLimit);
      if (directItems.length >= directLimit || fetched.length < fetchSize || fetchSize >= directLimit * MAX_FETCH_MULTIPLIER) {
        break;
      }
      fetchSize = Math.min(fetchSize * 2, directLimit * MAX_FETCH_MULTIPLIER);
    }
  } else {
    directItems = directItemSearch(query, directLimit, scopeIds);
  }

  // -- Early termination check --
  // If cheap sources already produced enough high-relevance candidates,
  // skip the expensive semantic search (Qdrant network call) and entity
  // relation traversal to reduce recall latency.
  //
  // Deduplicate before counting: lexical and recency can return the same
  // segment (common when recent messages match the query), so checking raw
  // counts would inflate the total and trigger early termination prematurely.
  const etConfig = config.memory.retrieval.earlyTermination;
  const cheapCandidateMap = new Map<string, Candidate>();
  for (const c of [...lexical, ...recency, ...directItems]) {
    const existing = cheapCandidateMap.get(c.key);
    // Keep the candidate with higher query relevance (lexical score is the
    // best proxy we have at this stage; confidence reflects extraction
    // certainty, not query-match strength).
    if (!existing || c.lexical > existing.lexical) {
      cheapCandidateMap.set(c.key, c);
    }
  }
  const cheapCandidates = [...cheapCandidateMap.values()];

  // Gate on relevance instead of confidence: for direct item candidates,
  // c.confidence reflects extraction certainty (memory_items.confidence),
  // not query-match relevance. Common tokens can produce many high-confidence
  // but weakly relevant items that would skip semantic search exactly when
  // it's needed most. Instead, check lexical score (query-match relevance).
  const canTerminateEarly = etConfig.enabled
    && cheapCandidates.length >= etConfig.minCandidates
    && cheapCandidates.filter((c) => c.lexical >= etConfig.confidenceThreshold).length >= etConfig.minHighConfidence;

  // -- Phase 2: expensive searches (skipped on early termination) --
  // Semantic search (async Qdrant network call) and entity search (sync
  // SQLite graph traversal) are independent. Start the network call first,
  // run the sync work while it's in flight, then await the result.
  let semantic: Candidate[] = [];
  let semanticSearchFailed = false;
  let entity: Candidate[] = [];
  let candidateDepths: Map<string, number> | undefined;
  let relationSeedEntityCount = 0;
  let relationTraversedEdgeCount = 0;
  let relationNeighborEntityCount = 0;
  let relationExpandedItemCount = 0;

  if (!canTerminateEarly) {
    const semanticPromise = queryVector
      ? semanticSearch(queryVector, opts?.provider ?? 'unknown', opts?.model ?? 'unknown', config.memory.retrieval.semanticTopK, excludeMessageIds, scopeIds)
          .catch((err): Candidate[] => {
            semanticSearchFailed = true;
            if (isQdrantConnectionError(err)) {
              log.warn({ err }, 'Qdrant is unavailable — semantic search disabled, memory recall will be degraded');
            } else {
              log.warn({ err }, 'Semantic search failed, continuing with other retrieval methods');
            }
            return [];
          })
      : null;

    if (config.memory.entity.enabled) {
      const entitySearchResult = entitySearch(
        query,
        config.memory.entity,
        scopeIds,
        excludeMessageIds,
      );
      entity = entitySearchResult.candidates;
      candidateDepths = entitySearchResult.candidateDepths;
      relationSeedEntityCount = entitySearchResult.relationSeedEntityCount;
      relationTraversedEdgeCount = entitySearchResult.relationTraversedEdgeCount;
      relationNeighborEntityCount = entitySearchResult.relationNeighborEntityCount;
      relationExpandedItemCount = entitySearchResult.relationExpandedItemCount;
    }

    if (semanticPromise) {
      semantic = await semanticPromise;
    }
  }

  if (canTerminateEarly) {
    log.debug(
      { cheapCandidateCount: cheapCandidates.length, highRelevanceCount: cheapCandidates.filter((c) => c.lexical >= etConfig.confidenceThreshold).length },
      'Early termination: skipping semantic and entity search — sufficient high-relevance candidates from cheap sources',
    );
  }

  const relationScoreMultiplier = config.memory.entity.enabled && config.memory.entity.relationRetrieval.enabled
    ? config.memory.entity.relationRetrieval.neighborScoreMultiplier
    : undefined;
  const depthMap = config.memory.entity.enabled && config.memory.entity.relationRetrieval.depthDecay
    ? candidateDepths
    : undefined;
  const merged = mergeCandidates(lexical, semantic, recency, [...entity, ...directItems], config.memory.retrieval.freshness, relationScoreMultiplier, depthMap);

  return {
    lexical,
    recency,
    semantic,
    entity,
    relationSeedEntityCount,
    relationTraversedEdgeCount,
    relationNeighborEntityCount,
    relationExpandedItemCount,
    earlyTerminated: canTerminateEarly,
    semanticSearchFailed,
    merged,
  };
}

export async function buildMemoryRecall(
  query: string,
  conversationId: string,
  config: AssistantConfig,
  options?: MemoryRecallOptions,
): Promise<MemoryRecallResult> {
  const start = Date.now();
  const versionSnapshot = getMemoryVersion();
  const excludeMessageIds = options?.excludeMessageIds?.filter((id) => id.length > 0) ?? [];
  const signal = options?.signal;
  if (!config.memory.enabled) {
    return emptyResult({ enabled: false, degraded: false, reason: 'memory.disabled', latencyMs: Date.now() - start });
  }
  if (signal?.aborted) {
    return emptyResult({ enabled: true, degraded: false, reason: 'memory.aborted', latencyMs: Date.now() - start });
  }

  // Check recall cache — serves identical results instantly when the query
  // and memory state haven't changed since the last recall.
  const cached = getCachedRecall(query, conversationId, options);
  if (cached) {
    log.debug({ query: truncate(query, 120), latencyMs: Date.now() - start }, 'Memory recall served from cache');
    return { ...cached, latencyMs: Date.now() - start };
  }

  const backendStatus = getMemoryBackendStatus(config);
  let queryVector: number[] | null = null;
  let provider: string | undefined;
  let model: string | undefined;
  let degraded = backendStatus.degraded;
  let reason = backendStatus.reason ?? undefined;

  if (backendStatus.provider) {
    try {
      const embedded = await embedWithBackend(config, [query], { signal });
      queryVector = embedded.vectors[0] ?? null;
      provider = embedded.provider;
      model = embedded.model;
      degraded = false;
      reason = undefined;
    } catch (err) {
      if (signal?.aborted || isAbortError(err)) {
        return emptyResult({
          enabled: true,
          degraded: false,
          reason: 'memory.aborted',
          provider: backendStatus.provider,
          model: backendStatus.model ?? undefined,
          latencyMs: Date.now() - start,
        });
      }
      logMemoryEmbeddingWarning(err, 'query');
      degraded = config.memory.embeddings.required;
      reason = `memory.embedding_failure: ${err instanceof Error ? err.message : String(err)}`;
      if (config.memory.embeddings.required) {
        return emptyResult({
          enabled: true,
          degraded,
          reason,
          provider: backendStatus.provider,
          model: backendStatus.model ?? undefined,
          latencyMs: Date.now() - start,
        });
      }
    }
  } else if (config.memory.embeddings.required) {
    return emptyResult({
      enabled: true,
      degraded: true,
      reason: reason ?? 'memory.embedding_backend_missing',
      latencyMs: Date.now() - start,
    });
  }

  let collected: CollectedCandidates;
  try {
    collected = await collectAndMergeCandidates(query, config, {
      queryVector,
      provider,
      model,
      conversationId,
      excludeMessageIds,
      scopeId: options?.scopeId,
      scopePolicyOverride: options?.scopePolicyOverride,
    });
  } catch (err) {
    if (signal?.aborted || isAbortError(err)) {
      return emptyResult({
        enabled: true,
        degraded: false,
        reason: 'memory.aborted',
        provider,
        model,
        latencyMs: Date.now() - start,
      });
    }
    log.warn({ err }, 'Memory retrieval failed, returning degraded empty recall');
    return emptyResult({
      enabled: true,
      degraded: true,
      reason: `memory.retrieval_failure: ${err instanceof Error ? err.message : String(err)}`,
      provider,
      model,
      latencyMs: Date.now() - start,
    });
  }

  const {
    lexical: lexicalCandidates,
    recency: recencyCandidates,
    semantic: semanticCandidates,
    entity: entityCandidates,
    relationSeedEntityCount,
    relationTraversedEdgeCount,
    relationNeighborEntityCount,
    relationExpandedItemCount,
    earlyTerminated,
    semanticSearchFailed,
  } = collected;

  // Mark as degraded when semantic search failed — the recall is based on
  // lexical/recency only and should not be cached.
  if (semanticSearchFailed) {
    degraded = true;
    reason = reason ?? 'memory.semantic_search_failure';
  }
  let merged = applySourceCaps(collected.merged, config);

  // LLM re-ranking: send top candidates to Haiku for relevance scoring
  const rerankingConfig = config.memory.retrieval.reranking;
  let rerankApplied = false;
  if (rerankingConfig.enabled && merged.length >= 5) {
    const rerankStart = Date.now();
    const topCandidates = merged.slice(0, rerankingConfig.topK);
    try {
      const reranked = await rerankWithLLM(query, topCandidates, rerankingConfig);
      // Replace the top portion with re-ranked results, keep any overflow untouched
      merged = [...reranked, ...merged.slice(rerankingConfig.topK)];
      rerankApplied = true;
      log.debug({ rerankLatencyMs: Date.now() - rerankStart, rerankedCount: reranked.length }, 'LLM re-ranking completed');
    } catch (err) {
      if (signal?.aborted || isAbortError(err)) {
        return emptyResult({
          enabled: true,
          degraded: false,
          reason: 'memory.aborted',
          provider,
          model,
          latencyMs: Date.now() - start,
        });
      }
      log.warn({ err, rerankLatencyMs: Date.now() - rerankStart }, 'LLM re-ranking failed, using RRF order');
    }
  }

  const mergedCount = merged.length;
  const maxInjectTokens = Math.max(
    1,
    Math.floor(options?.maxInjectTokensOverride ?? config.memory.retrieval.maxInjectTokens),
  );
  const selected = trimToTokenBudget(merged, maxInjectTokens, config.memory.retrieval.injectionFormat);
  markItemUsage(selected);

  const injectedText = buildInjectedText(selected, config.memory.retrieval.injectionFormat);
  const topCandidates: MemoryRecallCandiateDebug[] = selected.slice(0, 10).map((c) => ({
    key: c.key,
    type: c.type,
    kind: c.kind,
    finalScore: c.finalScore,
    lexical: c.lexical,
    semantic: c.semantic,
    recency: c.recency,
  }));

  const latencyMs = Date.now() - start;
  log.debug({
    query: truncate(query, 120),
    lexicalHits: lexicalCandidates.length,
    semanticHits: semanticCandidates.length,
    recencyHits: recencyCandidates.length,
    entityHits: entityCandidates.length,
    relationSeedEntityCount,
    relationTraversedEdgeCount,
    relationNeighborEntityCount,
    relationExpandedItemCount,
    earlyTerminated,
    mergedCount,
    selected: selected.length,
    maxInjectTokens,
    rerankApplied,
    injectedTokens: estimateTextTokens(injectedText),
    latencyMs,
  }, 'Memory recall completed');

  const result: MemoryRecallResult = {
    enabled: true,
    degraded,
    reason,
    provider,
    model,
    lexicalHits: lexicalCandidates.length,
    semanticHits: semanticCandidates.length,
    recencyHits: recencyCandidates.length,
    entityHits: entityCandidates.length,
    relationSeedEntityCount,
    relationTraversedEdgeCount,
    relationNeighborEntityCount,
    relationExpandedItemCount,
    earlyTerminated,
    mergedCount,
    selectedCount: selected.length,
    rerankApplied,
    injectedTokens: estimateTextTokens(injectedText),
    injectedText,
    latencyMs,
    topCandidates,
  };

  // Only cache non-degraded results — degraded results (e.g. lexical-only
  // fallback when embeddings fail) would delay quality recovery once the
  // embedding backend comes back.
  if (!result.degraded) {
    setCachedRecall(query, conversationId, options, result, versionSnapshot);
  }
  return result;
}

export function stripMemoryRecallMessages<T extends { role: 'user' | 'assistant'; content: Array<{ type: string; text?: string }> }>(
  messages: T[],
  memoryRecallText?: string,
  injectionStrategy?: 'prepend_user_block' | 'separate_context_message',
): T[] {
  const recallText = memoryRecallText ?? '';
  if (recallText.trim().length === 0) return messages;

  // Try separate_context_message pattern first: look for the injected
  // user+assistant pair (user message whose sole text block is the recall
  // text, followed by an assistant ack message).
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== 'user') continue;
    if (message.content.length !== 1) continue;
    const block = message.content[0];
    if (block.type !== 'text' || block.text !== recallText) continue;
    // Check if the next message is the assistant ack
    const next = messages[index + 1];
    if (
      next &&
      next.role === 'assistant' &&
      next.content.length === 1 &&
      next.content[0].type === 'text' &&
      next.content[0].text === MEMORY_CONTEXT_ACK
    ) {
      // Remove both the user context message and the assistant ack
      return [...messages.slice(0, index), ...messages.slice(index + 2)];
    }
  }

  // Fall back to prepend_user_block pattern: the recall text is a block
  // inside a user message that also has real user content.
  let targetIndex = -1;
  let blockIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== 'user' || message.content.length === 0) continue;
    let foundBlock = -1;
    for (let bi = message.content.length - 1; bi >= 0; bi--) {
      const block = message.content[bi];
      if (block.type === 'text' && block.text === recallText) {
        foundBlock = bi;
        break;
      }
    }
    if (foundBlock !== -1) {
      targetIndex = index;
      blockIndex = foundBlock;
      break;
    }
  }
  if (targetIndex === -1) return messages;

  // Check if the message after targetIndex is the assistant ack from a
  // merged separate-context injection (deepRepairHistory can merge the
  // standalone recall user message into an adjacent user message, leaving
  // the ack orphaned). Only check when the injection strategy is
  // separate_context_message -- prepend_user_block never injects a
  // synthetic ack, so stripping here would delete a real assistant reply.
  const ackIndex =
    injectionStrategy !== 'prepend_user_block' &&
    targetIndex + 1 < messages.length &&
    messages[targetIndex + 1].role === 'assistant' &&
    messages[targetIndex + 1].content.length === 1 &&
    messages[targetIndex + 1].content[0].type === 'text' &&
    messages[targetIndex + 1].content[0].text === MEMORY_CONTEXT_ACK
      ? targetIndex + 1
      : -1;

  const cleaned: T[] = [];
  for (let index = 0; index < messages.length; index++) {
    if (index === ackIndex) continue;
    const message = messages[index];
    if (index !== targetIndex) {
      cleaned.push(message);
      continue;
    }
    const filteredContent = [
      ...message.content.slice(0, blockIndex),
      ...message.content.slice(blockIndex + 1),
    ];
    if (filteredContent.length === 0) continue;
    cleaned.push({ ...message, content: filteredContent } as T);
  }
  return cleaned;
}

export function injectMemoryRecallIntoUserMessage<T extends { role: 'user' | 'assistant'; content: Array<{ type: string; text?: string }> }>(
  message: T,
  memoryRecallText: string,
): T {
  if (message.role !== 'user') return message;
  if (memoryRecallText.trim().length === 0) return message;
  const memoryBlock = { type: 'text', text: memoryRecallText } as const;
  return {
    ...message,
    content: [memoryBlock, ...message.content] as T['content'],
  } as T;
}

/**
 * Inject memory recall as a separate user+assistant message pair before the
 * last user message. This separates memory context from the user's actual
 * query, making it clearer to the model that the memory is background context.
 */
export function injectMemoryRecallAsSeparateMessage<T extends { role: 'user' | 'assistant'; content: Array<{ type: string; text?: string }> }>(
  messages: T[],
  memoryRecallText: string,
): T[] {
  if (memoryRecallText.trim().length === 0) return messages;
  if (messages.length === 0) return messages;
  const contextMessage = {
    role: 'user' as const,
    content: [{ type: 'text', text: memoryRecallText }],
  } as unknown as T;
  const ackMessage = {
    role: 'assistant' as const,
    content: [{ type: 'text', text: MEMORY_CONTEXT_ACK }],
  } as unknown as T;
  return [
    ...messages.slice(0, -1),
    contextMessage,
    ackMessage,
    messages[messages.length - 1],
  ];
}

export function queryMemoryForCli(
  query: string,
  conversationId: string,
  config: AssistantConfig,
): Promise<MemoryRecallResult> {
  return buildMemoryRecall(query, conversationId, config);
}

/**
 * Search memory items using the same unified retrieval pipeline as
 * automatic recall: lexical, recency, semantic (when available), entity,
 * and direct item search -- merged via RRF.
 * Returns a simplified result set suitable for the memory_search tool.
 */
export async function searchMemoryItems(
  query: string,
  limit: number,
  config: AssistantConfig,
  scopeId?: string,
  scopePolicyOverride?: ScopePolicyOverride,
): Promise<MemorySearchResult[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0 || limit <= 0) return [];

  // Compute embedding vector when available (same as auto recall)
  let queryVector: number[] | null = null;
  let provider: string | undefined;
  let model: string | undefined;
  const backendStatus = getMemoryBackendStatus(config);
  if (backendStatus.provider) {
    try {
      const embedded = await embedWithBackend(config, [trimmed]);
      queryVector = embedded.vectors[0] ?? null;
      provider = embedded.provider;
      model = embedded.model;
    } catch {
      // Gracefully degrade to non-semantic search
    }
  }

  const result = await collectAndMergeCandidates(trimmed, config, {
    queryVector,
    provider,
    model,
    scopeId,
    scopePolicyOverride,
  });
  const merged = result.merged;

  return merged.slice(0, limit).map((c) => ({
    id: c.id,
    type: c.type,
    kind: c.kind,
    text: c.text,
    confidence: c.confidence,
    importance: c.importance,
    createdAt: c.createdAt,
    finalScore: c.finalScore,
    scores: {
      lexical: c.lexical,
      semantic: c.semantic,
      recency: c.recency,
    },
  }));
}

function emptyResult(
  init: Partial<MemoryRecallResult> & Pick<MemoryRecallResult, 'enabled' | 'degraded' | 'latencyMs'>,
): MemoryRecallResult {
  return {
    enabled: init.enabled,
    degraded: init.degraded,
    reason: init.reason,
    provider: init.provider,
    model: init.model,
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
    injectedText: '',
    latencyMs: init.latencyMs,
    topCandidates: [],
  };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || err.name === 'APIUserAbortError';
}
