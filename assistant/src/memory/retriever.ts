import { inArray, sql } from "drizzle-orm";

import type { AssistantConfig } from "../config/types.js";
import { estimateTextTokens } from "../context/token-estimator.js";
import { getLogger } from "../util/logger.js";
import {
  abortableSleep,
  computeRetryDelay,
  isRetryableNetworkError,
} from "../util/retry.js";
import { getDb } from "./db.js";
import {
  embedWithBackend,
  generateSparseEmbedding,
  getMemoryBackendStatus,
  logMemoryEmbeddingWarning,
} from "./embedding-backend.js";
import { formatRecallText } from "./format-recall.js";
import {
  isQdrantBreakerOpen,
  QdrantCircuitOpenError,
} from "./qdrant-circuit-breaker.js";
import { memoryItems, memoryItemSources, messages } from "./schema.js";
import {
  buildTwoLayerInjection,
  IDENTITY_KINDS,
  MEMORY_CONTEXT_ACK,
  PREFERENCE_KINDS,
} from "./search/formatting.js";
import { recencySearch } from "./search/lexical.js";
import { applySourceCaps, mergeCandidates } from "./search/ranking.js";
import { isQdrantConnectionError, semanticSearch } from "./search/semantic.js";
import { applyStaleDemotion, computeStaleness } from "./search/staleness.js";
import { classifyTiers } from "./search/tier-classifier.js";
import type {
  Candidate,
  CollectedCandidates,
  DegradationReason,
  DegradationStatus,
  FallbackSource,
  MemoryRecallCandiateDebug,
  MemoryRecallOptions,
  MemoryRecallResult,
  ScopePolicyOverride,
} from "./search/types.js";

// Re-export public types and functions so existing importers continue to work
export {
  escapeXmlTags,
  formatAbsoluteTime,
  formatRelativeTime,
} from "./search/formatting.js";
export type {
  DegradationReason,
  DegradationStatus,
  FallbackSource,
  MemoryRecallCandiateDebug,
  MemoryRecallResult,
  ScopePolicyOverride,
} from "./search/types.js";

const log = getLogger("memory-retriever");

const EMBED_MAX_RETRIES = 3;
const EMBED_BASE_DELAY_MS = 500;

/**
 * Wrap embedWithBackend with retry + exponential backoff for transient failures
 * (network errors, 429s, 5xx). Aborts immediately if the caller's signal fires.
 */
export async function embedWithRetry(
  config: AssistantConfig,
  texts: string[],
  opts?: { signal?: AbortSignal },
): ReturnType<typeof embedWithBackend> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= EMBED_MAX_RETRIES; attempt++) {
    try {
      return await embedWithBackend(config, texts, opts);
    } catch (err) {
      lastError = err;
      if (opts?.signal?.aborted || isAbortError(err)) throw err;
      const isTransient =
        isRetryableNetworkError(err) || isHttpStatusError(err);
      if (!isTransient || attempt === EMBED_MAX_RETRIES) throw err;
      const delay = computeRetryDelay(attempt, EMBED_BASE_DELAY_MS);
      log.warn(
        { err, attempt: attempt + 1, delayMs: Math.round(delay) },
        "Transient embedding failure, retrying",
      );
      await abortableSleep(delay, opts?.signal);
      if (opts?.signal?.aborted) throw err;
    }
  }
  throw lastError;
}

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
    if (scopePolicyOverride.fallbackToDefault && primary !== "default") {
      return [primary, "default"];
    }
    return [primary];
  }

  if (!scopeId) return undefined;
  if (scopePolicy === "allow_global_fallback") {
    return scopeId === "default" ? ["default"] : [scopeId, "default"];
  }
  return [scopeId];
}

/**
 * Shared retrieval pipeline: collect candidates from all available sources
 * (recency, semantic, direct item search) and merge them
 * using RRF.
 */
export async function collectAndMergeCandidates(
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
  const scopeIds = buildScopeFilter(
    scopeId,
    scopePolicy,
    opts?.scopePolicyOverride,
  );

  let semanticSearchFailed = false;
  let semanticSearchError: unknown;

  // Detect when semantic search won't be available.
  const semanticUnavailable = !queryVector || isQdrantBreakerOpen();
  if (semanticUnavailable) {
    log.debug("Semantic search unavailable — recency only");
  }

  // -- Phase 1: recency search (conversation-scoped supplementary query) --
  const baseRecencyLimit = Math.max(
    10,
    Math.floor(config.memory.retrieval.semanticTopK / 2),
  );
  const recencyLimit = semanticUnavailable
    ? Math.ceil(baseRecencyLimit * 1.5)
    : baseRecencyLimit;
  const recency = opts?.conversationId
    ? recencySearch(
        opts.conversationId,
        recencyLimit,
        excludeMessageIds,
        scopeIds,
      )
    : [];

  // -- Phase 2: semantic search --
  let semantic: Candidate[] = [];

  const semanticPromise = queryVector
    ? semanticSearch(
        queryVector,
        opts?.provider ?? "unknown",
        opts?.model ?? "unknown",
        config.memory.retrieval.semanticTopK,
        excludeMessageIds,
        scopeIds,
      ).catch((err): Candidate[] => {
        semanticSearchFailed = true;
        semanticSearchError = err;
        if (isQdrantConnectionError(err)) {
          log.warn(
            { err },
            "Qdrant is unavailable — semantic search disabled, memory recall will be degraded",
          );
        } else {
          log.warn(
            { err },
            "Semantic search failed, continuing with other retrieval methods",
          );
        }
        return [];
      })
    : null;

  if (semanticPromise) {
    semantic = await semanticPromise;
  }

  const lexical: Candidate[] = [];

  const merged = mergeCandidates(
    lexical,
    semantic,
    recency,
    [],
    config.memory.retrieval.freshness,
  );

  return {
    lexical,
    recency,
    semantic,
    entity: [],
    earlyTerminated: false,
    semanticSearchFailed,
    semanticUnavailable,
    semanticSearchError,
    merged,
  };
}

/**
 * Build a structured degradation status describing which retrieval
 * capabilities are unavailable and what fallback sources remain.
 */
function buildDegradationStatus(
  reason: DegradationReason,
  _config: AssistantConfig,
): DegradationStatus {
  const fallbackSources: FallbackSource[] = [
    "lexical",
    "recency",
    "direct_item",
  ];
  return {
    semanticUnavailable: true,
    reason,
    fallbackSources,
  };
}

/** Result of the embedding generation stage. */
interface EmbeddingResult {
  queryVector: number[] | null;
  provider: string | undefined;
  model: string | undefined;
  degraded: boolean;
  degradation: DegradationStatus | undefined;
  reason: string | undefined;
}

/**
 * Generate an embedding vector for the query. Handles backend availability
 * checks, retry with backoff, and graceful degradation when embeddings are
 * optional.
 *
 * Returns `null` when the caller should return an early-exit `emptyResult`
 * (the empty result is included). Otherwise returns the embedding state.
 */
async function generateQueryEmbedding(
  query: string,
  config: AssistantConfig,
  signal: AbortSignal | undefined,
  start: number,
): Promise<EmbeddingResult | { earlyExit: MemoryRecallResult }> {
  const backendStatus = getMemoryBackendStatus(config);
  let queryVector: number[] | null = null;
  let provider: string | undefined;
  let model: string | undefined;
  let degraded = backendStatus.degraded;
  let degradation: DegradationStatus | undefined;
  let reason = backendStatus.reason ?? undefined;

  if (backendStatus.provider) {
    try {
      const embedded = await embedWithRetry(config, [query], { signal });
      queryVector = embedded.vectors[0] ?? null;
      provider = embedded.provider;
      model = embedded.model;
      degraded = false;
      reason = undefined;
    } catch (err) {
      if (signal?.aborted || isAbortError(err)) {
        return {
          earlyExit: emptyResult({
            enabled: true,
            degraded: false,
            reason: "memory.aborted",
            provider: backendStatus.provider,
            model: backendStatus.model ?? undefined,
            latencyMs: Date.now() - start,
          }),
        };
      }
      logMemoryEmbeddingWarning(err, "query");
      degraded = true;
      reason = `memory.embedding_failure: ${
        err instanceof Error ? err.message : String(err)
      }`;
      degradation = buildDegradationStatus(
        "embedding_generation_failed",
        config,
      );
      if (config.memory.embeddings.required) {
        return {
          earlyExit: emptyResult({
            enabled: true,
            degraded,
            degradation,
            reason,
            provider: backendStatus.provider,
            model: backendStatus.model ?? undefined,
            latencyMs: Date.now() - start,
          }),
        };
      }
    }
  } else if (config.memory.embeddings.required) {
    degradation = buildDegradationStatus("embedding_provider_down", config);
    return {
      earlyExit: emptyResult({
        enabled: true,
        degraded: true,
        degradation,
        reason: reason ?? "memory.embedding_backend_missing",
        latencyMs: Date.now() - start,
      }),
    };
  }

  return { queryVector, provider, model, degraded, degradation, reason };
}

/** Result of the re-ranking stage. */
interface RerankResult {
  merged: Candidate[];
  rerankApplied: boolean;
}

/**
 * Apply source caps to the merged candidates.
 */
function rerankMergedCandidates(
  candidates: Candidate[],
  config: AssistantConfig,
): RerankResult {
  const merged = applySourceCaps(candidates, config);
  return { merged, rerankApplied: false };
}

/**
 * Trim candidates to the token budget, format for injection, and assemble
 * the final `MemoryRecallResult`.
 */
function formatRecallResult(
  query: string,
  collected: CollectedCandidates,
  merged: Candidate[],
  rerankApplied: boolean,
  config: AssistantConfig,
  options: MemoryRecallOptions | undefined,
  embedding: EmbeddingResult,
  start: number,
): MemoryRecallResult {
  const mergedCount = merged.length;
  const maxInjectTokens = Math.max(
    1,
    Math.floor(
      options?.maxInjectTokensOverride ??
        config.memory.retrieval.maxInjectTokens,
    ),
  );

  const formatted = formatRecallText(merged, {
    format: config.memory.retrieval.injectionFormat,
    maxTokens: maxInjectTokens,
  });
  const { selected } = formatted;
  const injectedText = formatted.text;

  const topCandidates: MemoryRecallCandiateDebug[] = selected
    .slice(0, 10)
    .map((c) => ({
      key: c.key,
      type: c.type,
      kind: c.kind,
      finalScore: c.finalScore,
      lexical: c.lexical,
      semantic: c.semantic,
      recency: c.recency,
    }));

  const latencyMs = Date.now() - start;
  log.debug(
    {
      query: truncate(query, 120),
      lexicalHits: collected.lexical.length,
      semanticHits: collected.semantic.length,
      recencyHits: collected.recency.length,
      entityHits: collected.entity.length,
      relationSeedEntityCount: 0,
      relationTraversedEdgeCount: 0,
      relationNeighborEntityCount: 0,
      relationExpandedItemCount: 0,
      earlyTerminated: collected.earlyTerminated,
      mergedCount,
      selected: selected.length,
      maxInjectTokens,
      rerankApplied,
      injectedTokens: estimateTextTokens(injectedText),
      latencyMs,
    },
    "Memory recall completed",
  );

  return {
    enabled: true,
    degraded: embedding.degraded,
    degradation: embedding.degradation,
    reason: embedding.reason,
    provider: embedding.provider,
    model: embedding.model,
    lexicalHits: collected.lexical.length,
    semanticHits: collected.semantic.length,
    recencyHits: collected.recency.length,
    entityHits: collected.entity.length,
    relationSeedEntityCount: 0,
    relationTraversedEdgeCount: 0,
    relationNeighborEntityCount: 0,
    relationExpandedItemCount: 0,
    earlyTerminated: collected.earlyTerminated,
    mergedCount,
    selectedCount: selected.length,
    rerankApplied,
    injectedTokens: estimateTextTokens(injectedText),
    injectedText,
    latencyMs,
    topCandidates,
  };
}

export async function buildMemoryRecall(
  query: string,
  conversationId: string,
  config: AssistantConfig,
  options?: MemoryRecallOptions,
): Promise<MemoryRecallResult> {
  const start = Date.now();
  const excludeMessageIds =
    options?.excludeMessageIds?.filter((id) => id.length > 0) ?? [];
  const signal = options?.signal;
  if (!config.memory.enabled) {
    return emptyResult({
      enabled: false,
      degraded: false,
      reason: "memory.disabled",
      latencyMs: Date.now() - start,
    });
  }
  if (signal?.aborted) {
    return emptyResult({
      enabled: true,
      degraded: false,
      reason: "memory.aborted",
      latencyMs: Date.now() - start,
    });
  }

  // Stage 1: Embedding generation
  const embeddingResult = await generateQueryEmbedding(
    query,
    config,
    signal,
    start,
  );
  if ("earlyExit" in embeddingResult) return embeddingResult.earlyExit;

  // Stage 2: Candidate collection (recency, semantic)
  let collected: CollectedCandidates;
  try {
    collected = await collectAndMergeCandidates(query, config, {
      queryVector: embeddingResult.queryVector,
      provider: embeddingResult.provider,
      model: embeddingResult.model,
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
        reason: "memory.aborted",
        provider: embeddingResult.provider,
        model: embeddingResult.model,
        latencyMs: Date.now() - start,
      });
    }
    log.warn(
      { err },
      "Memory retrieval failed, returning degraded empty recall",
    );
    return emptyResult({
      enabled: true,
      degraded: true,
      reason: `memory.retrieval_failure: ${
        err instanceof Error ? err.message : String(err)
      }`,
      provider: embeddingResult.provider,
      model: embeddingResult.model,
      latencyMs: Date.now() - start,
    });
  }

  // Propagate semantic search failure or breaker-based unavailability into
  // degradation state. This ensures results computed with boosted limits
  // are marked degraded and excluded from the recall cache — preventing
  // stale boosted results from being served after the breaker closes.
  //
  // Exception: when semanticUnavailable is solely because no embedding
  // provider is configured (queryVector == null) and embeddings are not
  // required, lexical-only results are the expected steady state — do not
  // mark as degraded.
  const semanticActuallyFailed =
    collected.semanticSearchFailed ||
    (collected.semanticUnavailable &&
      (embeddingResult.queryVector != null ||
        config.memory.embeddings.required));
  if (semanticActuallyFailed) {
    embeddingResult.degraded = true;
    embeddingResult.reason =
      embeddingResult.reason ??
      (collected.semanticUnavailable
        ? embeddingResult.queryVector != null
          ? "memory.qdrant_circuit_open"
          : "memory.embedding_unavailable"
        : "memory.semantic_search_failure");
    if (!embeddingResult.degradation) {
      const isQdrantIssue =
        embeddingResult.queryVector != null ||
        isQdrantConnectionError(collected.semanticSearchError) ||
        collected.semanticSearchError instanceof QdrantCircuitOpenError;
      const reason: DegradationReason = isQdrantIssue
        ? "qdrant_unavailable"
        : "embedding_generation_failed";
      embeddingResult.degradation = buildDegradationStatus(reason, config);
    }
  }

  // Stage 3: Source caps
  const rerankResult = rerankMergedCandidates(collected.merged, config);

  // Stage 4: Token budget trimming and result formatting
  const result = formatRecallResult(
    query,
    collected,
    rerankResult.merged,
    rerankResult.rerankApplied,
    config,
    options,
    embeddingResult,
    start,
  );

  return result;
}

/**
 * V2 memory recall pipeline: simplified hybrid search → tier classification →
 * staleness annotation → two-layer XML injection.
 *
 * Pipeline steps:
 *   1. Build query text (caller provides via buildMemoryQuery)
 *   2. Generate dense + sparse embeddings
 *   3. Hybrid search on Qdrant (dense + sparse RRF fusion)
 *   4. Supplement with recency search (conversation-scoped, DB only)
 *   5. Merge + deduplicate results
 *   6. Classify tiers (score > 0.8 → tier 1, > 0.6 → tier 2)
 *   7. Enrich item candidates with metadata for staleness
 *   8. Compute staleness per item
 *   9. Demote very_stale tier 1 → tier 2
 *  10. Build two-layer XML injection with budget allocation
 */
export async function buildMemoryRecallV2(
  query: string,
  conversationId: string,
  config: AssistantConfig,
  options?: MemoryRecallOptions,
): Promise<MemoryRecallResult> {
  const start = Date.now();
  const excludeMessageIds =
    options?.excludeMessageIds?.filter((id) => id.length > 0) ?? [];
  const signal = options?.signal;

  if (!config.memory.enabled) {
    return emptyResult({
      enabled: false,
      degraded: false,
      reason: "memory.disabled",
      latencyMs: Date.now() - start,
    });
  }
  if (signal?.aborted) {
    return emptyResult({
      enabled: true,
      degraded: false,
      reason: "memory.aborted",
      latencyMs: Date.now() - start,
    });
  }

  // ── Step 1+2: Generate dense and sparse embeddings ──────────────
  const embeddingResult = await generateQueryEmbedding(
    query,
    config,
    signal,
    start,
  );
  if ("earlyExit" in embeddingResult) return embeddingResult.earlyExit;

  const { queryVector, provider, model } = embeddingResult;

  // Generate sparse embedding for the query text (TF-IDF based)
  const sparseVector = generateSparseEmbedding(query);

  // ── Step 3: Hybrid search on Qdrant ─────────────────────────────
  const scopePolicy = config.memory.retrieval.scopePolicy;
  const scopeIds = buildScopeFilter(
    options?.scopeId,
    scopePolicy,
    options?.scopePolicyOverride,
  );

  const HYBRID_LIMIT = 20;

  let hybridCandidates: Candidate[] = [];
  let semanticSearchFailed = false;
  const hybridSearchStart = Date.now();

  if (queryVector && !isQdrantBreakerOpen()) {
    try {
      hybridCandidates = await semanticSearch(
        queryVector,
        provider ?? "unknown",
        model ?? "unknown",
        HYBRID_LIMIT,
        excludeMessageIds,
        scopeIds,
        sparseVector.indices.length > 0 ? sparseVector : undefined,
      );
    } catch (err) {
      semanticSearchFailed = true;
      if (isQdrantConnectionError(err)) {
        log.warn(
          { err },
          "Qdrant unavailable — hybrid search disabled for V2 pipeline",
        );
      } else {
        log.warn(
          { err },
          "Hybrid search failed in V2 pipeline, continuing with recency only",
        );
      }
    }
  }
  const hybridSearchMs = Date.now() - hybridSearchStart;

  // ── Step 4: Recency supplement (DB only, conversation-scoped) ───
  const recencyLimit = 5;
  const recencyCandidates = conversationId
    ? recencySearch(conversationId, recencyLimit, excludeMessageIds, scopeIds)
    : [];

  // ── Step 5: Merge and deduplicate ──────────────────────────────
  const candidateMap = new Map<string, Candidate>();
  for (const c of [...hybridCandidates, ...recencyCandidates]) {
    const existing = candidateMap.get(c.key);
    if (!existing) {
      candidateMap.set(c.key, { ...c });
      continue;
    }
    // Keep highest scores from each source
    existing.lexical = Math.max(existing.lexical, c.lexical);
    existing.semantic = Math.max(existing.semantic, c.semantic);
    existing.recency = Math.max(existing.recency, c.recency);
    existing.confidence = Math.max(existing.confidence, c.confidence);
    existing.importance = Math.max(existing.importance, c.importance);
    if (c.text.length > existing.text.length) {
      existing.text = c.text;
    }
  }

  // Compute RRF-style final scores for the merged candidates
  const allCandidates = [...candidateMap.values()];
  for (const c of allCandidates) {
    // Simple weighted combination — hybrid search already applies RRF fusion
    // at the Qdrant level; here we combine the fused semantic score with recency.
    c.finalScore = c.semantic * 0.7 + c.recency * 0.2 + c.confidence * 0.1;
  }
  allCandidates.sort((a, b) => b.finalScore - a.finalScore);

  // ── Step 6: Tier classification ─────────────────────────────────
  const tiered = classifyTiers(allCandidates);

  // ── Step 7: Enrich with item metadata for staleness ─────────────
  const itemIds = tiered.filter((c) => c.type === "item").map((c) => c.id);
  const itemMetadataMap = enrichItemMetadata(itemIds);

  // ── Step 8: Compute staleness per item ──────────────────────────
  const now = Date.now();
  for (const c of tiered) {
    if (c.type !== "item") continue;
    const meta = itemMetadataMap.get(c.id);
    if (!meta) continue;
    const { level } = computeStaleness(
      {
        kind: c.kind,
        firstSeenAt: meta.firstSeenAt,
        sourceConversationCount: meta.sourceConversationCount,
      },
      now,
    );
    c.staleness = level;
  }

  // ── Step 9: Demote very_stale tier 1 → tier 2 ──────────────────
  const afterDemotion = applyStaleDemotion(tiered);

  // ── Step 10: Budget allocation and two-layer injection ──────────
  const maxInjectTokens = Math.max(
    1,
    Math.floor(
      options?.maxInjectTokensOverride ??
        config.memory.retrieval.maxInjectTokens,
    ),
  );

  // Split into sections for two-layer injection
  const identityItems = afterDemotion.filter(
    (c) => c.tier === 1 && IDENTITY_KINDS.has(c.kind),
  );
  const preferences = afterDemotion.filter(
    (c) => c.tier === 1 && PREFERENCE_KINDS.has(c.kind),
  );
  const tier1Candidates = afterDemotion.filter(
    (c) =>
      c.tier === 1 &&
      !IDENTITY_KINDS.has(c.kind) &&
      !PREFERENCE_KINDS.has(c.kind),
  );
  const tier2Candidates = afterDemotion.filter((c) => c.tier === 2);

  const injectedText = buildTwoLayerInjection({
    identityItems,
    tier1Candidates,
    tier2Candidates,
    preferences,
    totalBudgetTokens: maxInjectTokens,
  });

  // ── Assemble result ─────────────────────────────────────────────
  const selectedCount =
    identityItems.length +
    tier1Candidates.length +
    tier2Candidates.length +
    preferences.length;

  const tier1Count = afterDemotion.filter((c) => c.tier === 1).length;
  const tier2Count = afterDemotion.filter((c) => c.tier === 2).length;
  const stalenessStats = {
    fresh: afterDemotion.filter((c) => c.staleness === "fresh").length,
    aging: afterDemotion.filter((c) => c.staleness === "aging").length,
    stale: afterDemotion.filter((c) => c.staleness === "stale").length,
    very_stale: afterDemotion.filter((c) => c.staleness === "very_stale")
      .length,
  };

  const topCandidates: MemoryRecallCandiateDebug[] = afterDemotion
    .slice(0, 10)
    .map((c) => ({
      key: c.key,
      type: c.type,
      kind: c.kind,
      finalScore: c.finalScore,
      lexical: c.lexical,
      semantic: c.semantic,
      recency: c.recency,
    }));

  const latencyMs = Date.now() - start;

  // Propagate degradation from semantic search failure
  if (
    semanticSearchFailed ||
    (!queryVector && config.memory.embeddings.required)
  ) {
    embeddingResult.degraded = true;
    embeddingResult.reason =
      embeddingResult.reason ?? "memory.hybrid_search_failure";
  }

  log.debug(
    {
      query: truncate(query, 120),
      hybridHits: hybridCandidates.length,
      recencyHits: recencyCandidates.length,
      mergedCount: allCandidates.length,
      tier1Count,
      tier2Count,
      stalenessStats,
      selectedCount,
      maxInjectTokens,
      injectedTokens: estimateTextTokens(injectedText),
      latencyMs,
    },
    "Memory recall V2 completed",
  );

  const result: MemoryRecallResult = {
    enabled: true,
    degraded: embeddingResult.degraded,
    degradation: embeddingResult.degradation,
    reason: embeddingResult.reason,
    provider: embeddingResult.provider,
    model: embeddingResult.model,
    // Backwards-compatible fields for event emission in session-memory.ts
    lexicalHits: 0,
    semanticHits: hybridCandidates.length,
    recencyHits: recencyCandidates.length,
    entityHits: 0,
    relationSeedEntityCount: 0,
    relationTraversedEdgeCount: 0,
    relationNeighborEntityCount: 0,
    relationExpandedItemCount: 0,
    earlyTerminated: false,
    mergedCount: allCandidates.length,
    selectedCount,
    rerankApplied: false,
    injectedTokens: estimateTextTokens(injectedText),
    injectedText,
    latencyMs,
    topCandidates,
    tier1Count,
    tier2Count,
    hybridSearchMs,
  };

  return result;
}

/**
 * Enrich item candidates with metadata needed for staleness computation:
 * - firstSeenAt: when the item was first extracted
 * - sourceConversationCount: number of distinct conversations that sourced this item
 */
function enrichItemMetadata(
  itemIds: string[],
): Map<
  string,
  { firstSeenAt: number; sourceConversationCount: number; kind: string }
> {
  const result = new Map<
    string,
    { firstSeenAt: number; sourceConversationCount: number; kind: string }
  >();
  if (itemIds.length === 0) return result;

  try {
    const db = getDb();

    // Fetch firstSeenAt and kind from memory_items
    const items = db
      .select({
        id: memoryItems.id,
        firstSeenAt: memoryItems.firstSeenAt,
        kind: memoryItems.kind,
      })
      .from(memoryItems)
      .where(inArray(memoryItems.id, itemIds))
      .all();

    for (const item of items) {
      result.set(item.id, {
        firstSeenAt: item.firstSeenAt,
        kind: item.kind,
        sourceConversationCount: 1, // default, updated below
      });
    }

    // Compute sourceConversationCount: count distinct conversation IDs
    // across the memory_item_sources → messages join.
    const sourceCountRows = db
      .select({
        memoryItemId: memoryItemSources.memoryItemId,
        conversationCount:
          sql<number>`COUNT(DISTINCT ${messages.conversationId})`.as(
            "conversation_count",
          ),
      })
      .from(memoryItemSources)
      .innerJoin(messages, sql`${memoryItemSources.messageId} = ${messages.id}`)
      .where(inArray(memoryItemSources.memoryItemId, itemIds))
      .groupBy(memoryItemSources.memoryItemId)
      .all();

    for (const row of sourceCountRows) {
      const existing = result.get(row.memoryItemId);
      if (existing) {
        existing.sourceConversationCount = row.conversationCount;
      }
    }
  } catch (err) {
    log.warn(
      { err },
      "Failed to enrich item metadata for staleness computation",
    );
  }

  return result;
}

export function stripMemoryRecallMessages<
  T extends {
    role: "user" | "assistant";
    content: Array<{ type: string; text?: string }>;
  },
>(
  messages: T[],
  memoryRecallText?: string,
  injectionStrategy?: "prepend_user_block" | "separate_context_message",
): T[] {
  const recallText = memoryRecallText ?? "";
  if (recallText.trim().length === 0) return messages;

  const isAck = (msg: T) =>
    msg.role === "assistant" &&
    msg.content.length === 1 &&
    msg.content[0].type === "text" &&
    msg.content[0].text === MEMORY_CONTEXT_ACK;

  // Prefer the canonical separate_context_message pair: a user message whose
  // sole text block is the recall text, followed by an assistant ack. This
  // must be checked first so that a real user message that happens to contain
  // the same text is not incorrectly removed instead of the synthetic one.
  if (injectionStrategy !== "prepend_user_block") {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== "user") continue;
      if (msg.content.length !== 1) continue;
      const block = msg.content[0];
      if (block.type !== "text" || block.text !== recallText) continue;
      const next = messages[i + 1];
      if (next && isAck(next)) {
        return [...messages.slice(0, i), ...messages.slice(i + 2)];
      }
    }
  }

  // Fall back to generic text-match removal: find the last user message
  // containing the recall text block (prepend_user_block or repair-merged).
  let targetIndex = -1;
  let blockIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user" || msg.content.length === 0) continue;
    for (let bi = msg.content.length - 1; bi >= 0; bi--) {
      const block = msg.content[bi];
      if (block.type === "text" && block.text === recallText) {
        targetIndex = i;
        blockIndex = bi;
        break;
      }
    }
    if (targetIndex !== -1) break;
  }
  if (targetIndex === -1) return messages;

  // Strip the adjacent assistant ack when the injection strategy used a
  // separate context message (or is unknown). This mirrors the canonical
  // pair removal above but covers repair-merged cases where the user
  // message has multiple content blocks.
  const ackIndex =
    injectionStrategy !== "prepend_user_block" &&
    targetIndex + 1 < messages.length &&
    isAck(messages[targetIndex + 1])
      ? targetIndex + 1
      : -1;

  const cleaned: T[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (i === ackIndex) continue;
    if (i !== targetIndex) {
      cleaned.push(messages[i]);
      continue;
    }
    const filteredContent = [
      ...messages[i].content.slice(0, blockIndex),
      ...messages[i].content.slice(blockIndex + 1),
    ];
    if (filteredContent.length === 0) continue;
    cleaned.push({ ...messages[i], content: filteredContent } as T);
  }
  return cleaned;
}

export function injectMemoryRecallIntoUserMessage<
  T extends {
    role: "user" | "assistant";
    content: Array<{ type: string; text?: string }>;
  },
>(message: T, memoryRecallText: string): T {
  if (message.role !== "user") return message;
  if (memoryRecallText.trim().length === 0) return message;
  const memoryBlock = { type: "text", text: memoryRecallText } as const;
  return {
    ...message,
    content: [memoryBlock, ...message.content] as T["content"],
  } as T;
}

/**
 * Inject memory recall as a separate user+assistant message pair before the
 * last user message. This separates memory context from the user's actual
 * query, making it clearer to the model that the memory is background context.
 */
export function injectMemoryRecallAsSeparateMessage<
  T extends {
    role: "user" | "assistant";
    content: Array<{ type: string; text?: string }>;
  },
>(messages: T[], memoryRecallText: string): T[] {
  if (memoryRecallText.trim().length === 0) return messages;
  if (messages.length === 0) return messages;
  // These synthetic messages satisfy the structural constraint T extends { role; content }
  // but may lack extra fields present on T. In practice T is always Message which has
  // only role and content, so the cast is safe.
  const contextMessage = {
    role: "user" as const,
    content: [{ type: "text" as const, text: memoryRecallText }],
  } as T;
  const ackMessage = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: MEMORY_CONTEXT_ACK }],
  } as T;
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

function emptyResult(
  init: Partial<MemoryRecallResult> &
    Pick<MemoryRecallResult, "enabled" | "degraded" | "latencyMs">,
): MemoryRecallResult {
  return {
    enabled: init.enabled,
    degraded: init.degraded,
    degradation: init.degradation,
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
    injectedText: "",
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
  return err.name === "AbortError" || err.name === "APIUserAbortError";
}

/**
 * Check if an error represents a retryable HTTP status (429 or 5xx).
 * Checks the error's `status` or `statusCode` property first (set by most
 * HTTP/API clients), then falls back to looking for "status <code>" patterns
 * in the message. This avoids false positives from dimension numbers like 512.
 */
function getErrorStatusCode(err: Error): unknown {
  if ("status" in err) {
    const status = (err as { status: unknown }).status;
    if (status != null) return status;
  }
  if ("statusCode" in err) return (err as { statusCode: unknown }).statusCode;
  return undefined;
}

function isHttpStatusError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const status = getErrorStatusCode(err);
  if (typeof status === "number") {
    return status === 429 || (status >= 500 && status < 600);
  }
  // Fall back to message matching, but only for patterns that clearly
  // indicate an HTTP status code rather than arbitrary numbers.
  // Matches: "status 503", "HTTP 500", "status code: 502", parenthesized
  // codes like "failed (503)" from Gemini/Ollama (requires "failed" or
  // "error" context to avoid false positives from dimension numbers like
  // 512), and bare "429" (rate-limit).
  return /\b429\b|(?:failed|error)\s*\((?:429|5\d{2})\)|(?:status|http)\s*(?:code\s*)?:?\s*5\d{2}\b/i.test(
    err.message,
  );
}
