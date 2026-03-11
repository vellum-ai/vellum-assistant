import { createHash } from "crypto";
import { inArray } from "drizzle-orm";

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
  getMemoryBackendStatus,
  logMemoryEmbeddingWarning,
} from "./embedding-backend.js";
import { formatRecallText } from "./format-recall.js";
import {
  isQdrantBreakerOpen,
  QdrantCircuitOpenError,
} from "./qdrant-circuit-breaker.js";
import {
  getCachedRecall,
  getMemoryVersion,
  setCachedRecall,
} from "./recall-cache.js";
import { memoryItemSources } from "./schema.js";
import { entitySearch } from "./search/entity.js";
import { MEMORY_CONTEXT_ACK } from "./search/formatting.js";
import {
  directItemSearch,
  lexicalSearch,
  recencySearch,
} from "./search/lexical.js";
import { buildFTSQuery, expandQueryForFTS } from "./search/query-expansion.js";
import {
  applySourceCaps,
  mergeCandidates,
  rerankWithLLM,
} from "./search/ranking.js";
import { isQdrantConnectionError, semanticSearch } from "./search/semantic.js";
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

/** Hash the retrieval-relevant config fields so the recall cache distinguishes different configs. */
function buildConfigFingerprint(config: AssistantConfig): string {
  const relevant = {
    r: config.memory.retrieval,
    e: {
      provider: config.memory.embeddings.provider,
      required: config.memory.embeddings.required,
    },
    ent: config.memory.entity.enabled,
  };
  return createHash("sha256")
    .update(JSON.stringify(relevant))
    .digest("hex")
    .slice(0, 16);
}

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
 * (lexical, recency, semantic, entity, direct item search) and merge them
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

  // Detect when semantic search won't be available so we can compensate
  // by boosting lexical/recency/direct item limits.
  const semanticUnavailable = !queryVector || isQdrantBreakerOpen();
  if (semanticUnavailable) {
    log.debug("Semantic search unavailable — boosting lexical limits");
  }

  // -- Phase 1: cheap local searches (always run) --
  const lexicalTopK = semanticUnavailable
    ? config.memory.retrieval.lexicalTopK * 2
    : config.memory.retrieval.lexicalTopK;

  // When semantic search is unavailable, expand the conversational query
  // into meaningful keywords for better FTS recall. This compensates for
  // the lack of vector-based semantic matching.
  const expandedFtsQuery = semanticUnavailable
    ? buildFTSQuery(expandQueryForFTS(query))
    : undefined;

  const lexical = lexicalSearch(
    query,
    lexicalTopK,
    excludeMessageIds,
    scopeIds,
    expandedFtsQuery,
  );

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

  // Direct item search supplements FTS with LIKE-based matching.
  // When exclusions are present, adaptively increase the fetch size until
  // we collect directLimit valid (non-excluded) items or exhaust the DB.
  const baseDirectLimit = Math.max(10, config.memory.retrieval.lexicalTopK);
  const directLimit = semanticUnavailable
    ? baseDirectLimit * 2
    : baseDirectLimit;

  // Helper: filter fetched direct items to those with at least one non-excluded source.
  const filterDirectItems = (items: Candidate[]): Candidate[] => {
    if (items.length === 0) return items;
    const db = getDb();
    const excludedSet = new Set(excludeMessageIds);
    const allSources = db
      .select({
        memoryItemId: memoryItemSources.memoryItemId,
        messageId: memoryItemSources.messageId,
      })
      .from(memoryItemSources)
      .where(
        inArray(
          memoryItemSources.memoryItemId,
          items.map((c) => c.id),
        ),
      )
      .all();
    const hasNonExcluded = new Set<string>();
    const hasSources = new Set<string>();
    for (const s of allSources) {
      hasSources.add(s.memoryItemId);
      if (!excludedSet.has(s.messageId)) {
        hasNonExcluded.add(s.memoryItemId);
      }
    }
    return items.filter(
      (c) => !hasSources.has(c.id) || hasNonExcluded.has(c.id),
    );
  };

  let directItems: Candidate[];
  if (excludeMessageIds.length > 0) {
    const MAX_FETCH = directLimit * 8;

    // Probe: fetch directLimit items and measure how many survive filtering.
    const probe = directItemSearch(query, directLimit, scopeIds);
    const probeFiltered = filterDirectItems(probe);
    const probeExhausted = probe.length < directLimit;

    if (probeFiltered.length >= directLimit || probeExhausted) {
      directItems = probeFiltered.slice(0, directLimit);
    } else {
      // Compute exclusion ratio from probe and extrapolate the fetch size
      // needed to yield directLimit surviving items in a single query.
      const exclusionRatio =
        probe.length > 0 ? 1 - probeFiltered.length / probe.length : 0;
      // Fetch enough to compensate for the observed exclusion rate, with
      // a 1.5x safety margin to avoid a second round in most cases.
      const estimatedFetch =
        exclusionRatio < 1
          ? Math.ceil((directLimit / (1 - exclusionRatio)) * 1.5)
          : MAX_FETCH;
      let fetchSize = Math.min(
        Math.max(estimatedFetch, directLimit + 24),
        MAX_FETCH,
      );

      let fetched = directItemSearch(query, fetchSize, scopeIds);
      directItems = filterDirectItems(fetched).slice(0, directLimit);

      // Retry loop: when the estimate under-fetched (uneven exclusion
      // distribution), keep increasing fetchSize until quota is met or
      // the DB is exhausted.
      while (
        directItems.length < directLimit &&
        fetched.length === fetchSize &&
        fetchSize < MAX_FETCH
      ) {
        fetchSize = Math.min(fetchSize * 2, MAX_FETCH);
        fetched = directItemSearch(query, fetchSize, scopeIds);
        directItems = filterDirectItems(fetched).slice(0, directLimit);
      }
    }
  } else {
    directItems = directItemSearch(query, directLimit, scopeIds);
  }

  // -- Early termination check --
  // If cheap sources already produced enough high-relevance candidates,
  // skip semantic and entity search entirely.
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
  //
  // Disable early termination when semantic search is unavailable: boosted
  // limits inflate cheap candidate counts, making this gate trigger more
  // easily. Skipping entity retrieval on top of losing semantic search
  // would reduce recall quality further.
  const canTerminateEarly =
    etConfig.enabled &&
    !semanticUnavailable &&
    cheapCandidates.length >= etConfig.minCandidates &&
    cheapCandidates.filter((c) => c.lexical >= etConfig.confidenceThreshold)
      .length >= etConfig.minHighConfidence;

  // -- Phase 2: entity search + await semantic (skipped on early termination) --
  let semantic: Candidate[] = [];
  let entity: Candidate[] = [];
  let candidateDepths: Map<string, number> | undefined;
  let relationSeedEntityCount = 0;
  let relationTraversedEdgeCount = 0;
  let relationNeighborEntityCount = 0;
  let relationExpandedItemCount = 0;

  if (!canTerminateEarly) {
    // Start semantic search now that we know early termination won't apply.
    // The network round-trip overlaps with entity search below.
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

    // Entity search is synchronous — run it while the semantic promise
    // is in flight.
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
      relationTraversedEdgeCount =
        entitySearchResult.relationTraversedEdgeCount;
      relationNeighborEntityCount =
        entitySearchResult.relationNeighborEntityCount;
      relationExpandedItemCount = entitySearchResult.relationExpandedItemCount;
    }

    if (semanticPromise) {
      semantic = await semanticPromise;
    }
  }

  if (canTerminateEarly) {
    log.debug(
      {
        cheapCandidateCount: cheapCandidates.length,
        highRelevanceCount: cheapCandidates.filter(
          (c) => c.lexical >= etConfig.confidenceThreshold,
        ).length,
      },
      "Early termination: skipping semantic and entity search — sufficient high-relevance candidates from cheap sources",
    );
  }

  const relationScoreMultiplier =
    config.memory.entity.enabled &&
    config.memory.entity.relationRetrieval.enabled
      ? config.memory.entity.relationRetrieval.neighborScoreMultiplier
      : undefined;
  const depthMap =
    config.memory.entity.enabled &&
    config.memory.entity.relationRetrieval.depthDecay
      ? candidateDepths
      : undefined;
  const merged = mergeCandidates(
    lexical,
    semantic,
    recency,
    [...entity, ...directItems],
    config.memory.retrieval.freshness,
    relationScoreMultiplier,
    depthMap,
  );

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
  config: AssistantConfig,
): DegradationStatus {
  const fallbackSources: FallbackSource[] = [
    "lexical",
    "recency",
    "direct_item",
  ];
  if (config.memory.entity.enabled) {
    fallbackSources.push("entity");
  }
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
 * Apply source caps and optionally LLM re-rank the merged candidates.
 * Returns `null` when the caller should return an early-exit `emptyResult`
 * (abort during re-ranking).
 */
async function rerankMergedCandidates(
  query: string,
  candidates: Candidate[],
  config: AssistantConfig,
  signal: AbortSignal | undefined,
  start: number,
  provider: string | undefined,
  model: string | undefined,
): Promise<RerankResult | { earlyExit: MemoryRecallResult }> {
  let merged = applySourceCaps(candidates, config);
  let rerankApplied = false;

  const rerankingConfig = config.memory.retrieval.reranking;
  if (rerankingConfig.enabled && merged.length >= 5) {
    const rerankStart = Date.now();
    const topCandidates = merged.slice(0, rerankingConfig.topK);
    try {
      const reranked = await rerankWithLLM(
        query,
        topCandidates,
        rerankingConfig,
      );
      merged = [...reranked, ...merged.slice(rerankingConfig.topK)];
      rerankApplied = true;
      log.debug(
        {
          rerankLatencyMs: Date.now() - rerankStart,
          rerankedCount: reranked.length,
        },
        "LLM re-ranking completed",
      );
    } catch (err) {
      if (signal?.aborted || isAbortError(err)) {
        return {
          earlyExit: emptyResult({
            enabled: true,
            degraded: false,
            reason: "memory.aborted",
            provider,
            model,
            latencyMs: Date.now() - start,
          }),
        };
      }
      log.warn(
        { err, rerankLatencyMs: Date.now() - rerankStart },
        "LLM re-ranking failed, using RRF order",
      );
    }
  }

  return { merged, rerankApplied };
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
      relationSeedEntityCount: collected.relationSeedEntityCount,
      relationTraversedEdgeCount: collected.relationTraversedEdgeCount,
      relationNeighborEntityCount: collected.relationNeighborEntityCount,
      relationExpandedItemCount: collected.relationExpandedItemCount,
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
    relationSeedEntityCount: collected.relationSeedEntityCount,
    relationTraversedEdgeCount: collected.relationTraversedEdgeCount,
    relationNeighborEntityCount: collected.relationNeighborEntityCount,
    relationExpandedItemCount: collected.relationExpandedItemCount,
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
  const versionSnapshot = getMemoryVersion();
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

  // Check recall cache
  const configFingerprint = buildConfigFingerprint(config);
  const cached = getCachedRecall(
    query,
    conversationId,
    options,
    configFingerprint,
  );
  if (cached) {
    log.debug(
      { query: truncate(query, 120), latencyMs: Date.now() - start },
      "Memory recall served from cache",
    );
    return { ...cached, latencyMs: Date.now() - start };
  }

  // Stage 1: Embedding generation
  const embeddingResult = await generateQueryEmbedding(
    query,
    config,
    signal,
    start,
  );
  if ("earlyExit" in embeddingResult) return embeddingResult.earlyExit;

  // Stage 2: Candidate collection (lexical, recency, direct, semantic, entity)
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

  // Stage 3: Source caps + LLM re-ranking
  const rerankResult = await rerankMergedCandidates(
    query,
    collected.merged,
    config,
    signal,
    start,
    embeddingResult.provider,
    embeddingResult.model,
  );
  if ("earlyExit" in rerankResult) return rerankResult.earlyExit;

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

  // Only cache non-degraded results — degraded results (e.g. lexical-only
  // fallback when embeddings fail) would delay quality recovery once the
  // embedding backend comes back.
  if (!result.degraded) {
    setCachedRecall(
      query,
      conversationId,
      options,
      result,
      versionSnapshot,
      configFingerprint,
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
