import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";

import type { AssistantConfig } from "../config/types.js";
import { estimateTextTokens } from "../context/token-estimator.js";
import type { Message } from "../providers/types.js";
import { getLogger } from "../util/logger.js";
import {
  abortableSleep,
  computeRetryDelay,
  isRetryableNetworkError,
} from "../util/retry.js";
import { getConversationDirName } from "./conversation-directories.js";
import { getDb } from "./db.js";
import {
  embedWithBackend,
  generateSparseEmbedding,
  getMemoryBackendStatus,
  logMemoryEmbeddingWarning,
} from "./embedding-backend.js";
import { isQdrantBreakerOpen } from "./qdrant-circuit-breaker.js";
import { expandQueryWithHyDE } from "./query-expansion.js";
import {
  conversations,
  memoryItems,
  memoryItemSources,
  messages,
} from "./schema.js";
import { buildMemoryInjection } from "./search/formatting.js";
import { applyMMR } from "./search/mmr.js";
import { isQdrantConnectionError, semanticSearch } from "./search/semantic.js";
import { computeStaleness } from "./search/staleness.js";
import {
  filterByMinScore,
  type TieredCandidate,
} from "./search/tier-classifier.js";
import type {
  Candidate,
  DegradationReason,
  DegradationStatus,
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
  lookupSupersessionChain,
} from "./search/formatting.js";
export type {
  DegradationReason,
  DegradationStatus,
  MemoryRecallCandiateDebug,
  MemoryRecallResult,
  ScopePolicyOverride,
} from "./search/types.js";

const log = getLogger("memory-retriever");

const EMBED_MAX_RETRIES = 3;
const EMBED_BASE_DELAY_MS = 500;

/** MMR diversity penalty applied to near-duplicate items after score filtering.
 *  0 = no penalty, 1 = maximum penalty. */
const MMR_PENALTY = 0.6;

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
 * Build a structured degradation status describing which retrieval
 * capabilities are unavailable and what fallback sources remain.
 */
function buildDegradationStatus(
  reason: DegradationReason,
  _config: AssistantConfig,
): DegradationStatus {
  return {
    semanticUnavailable: true,
    reason,
    fallbackSources: [],
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
  const backendStatus = await getMemoryBackendStatus(config);
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

/** Result from HyDE-expanded search. */
interface HyDESearchResult {
  candidates: Candidate[];
  hydeExpanded: boolean;
  hydeDocCount: number;
}

/**
 * Run HyDE-expanded search: generate hypothetical documents, embed them
 * alongside the raw query in parallel, run parallel semantic searches,
 * and merge all candidate arrays.
 *
 * Falls back to raw-query-only search on any HyDE failure (expansion
 * error, embedding error for hypothetical docs). The raw query search
 * always runs regardless of HyDE success.
 */
async function runHyDESearch(
  query: string,
  rawQueryVector: number[],
  config: AssistantConfig,
  signal: AbortSignal | undefined,
  provider: string,
  model: string,
  limit: number,
  excludeMessageIds: string[],
  scopeIds: string[] | undefined,
  sparseVector: { indices: number[]; values: number[] } | undefined,
): Promise<HyDESearchResult> {
  // Always search with the raw query — this is our baseline
  const rawSearchPromise = semanticSearch(
    rawQueryVector,
    provider,
    model,
    limit,
    excludeMessageIds,
    scopeIds,
    sparseVector,
  );
  // Suppress unhandled rejection if Qdrant rejects before we await
  rawSearchPromise.catch(() => {});

  // Attempt HyDE expansion — returns [] on any failure
  let hypotheticalDocs: string[];
  try {
    hypotheticalDocs = await expandQueryWithHyDE(query, config, signal);
  } catch {
    // expandQueryWithHyDE already catches internally, but be defensive
    hypotheticalDocs = [];
  }

  if (hypotheticalDocs.length === 0) {
    // No hypothetical docs — fall back to raw query only
    const rawResults = await rawSearchPromise;
    return {
      candidates: rawResults,
      hydeExpanded: false,
      hydeDocCount: 0,
    };
  }

  log.debug(
    { hydeDocCount: hypotheticalDocs.length },
    "HyDE expansion produced hypothetical documents",
  );

  // Embed all hypothetical docs in parallel with the raw search
  let hydeVectors: number[][] = [];
  try {
    const hydeEmbedResult = await embedWithRetry(config, hypotheticalDocs, {
      signal,
    });
    hydeVectors = hydeEmbedResult.vectors;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to embed HyDE hypothetical docs; falling back to raw query",
    );
    const rawResults = await rawSearchPromise;
    return {
      candidates: rawResults,
      hydeExpanded: false,
      hydeDocCount: 0,
    };
  }

  // Run parallel semantic searches for each hypothetical doc embedding,
  // generating per-doc sparse embeddings so sparse and dense components match.
  const hydeSearchPromises = hydeVectors.map((vector, i) => {
    const docSparseVector = generateSparseEmbedding(hypotheticalDocs[i]!);
    return semanticSearch(
      vector,
      provider,
      model,
      limit,
      excludeMessageIds,
      scopeIds,
      docSparseVector,
    ).catch((err) => {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "HyDE hypothetical doc search failed; skipping",
      );
      return [] as Candidate[];
    });
  });

  // Await all searches in parallel (raw + hypothetical)
  const [rawResults, ...hydeResults] = await Promise.all([
    rawSearchPromise,
    ...hydeSearchPromises,
  ]);

  // Merge all candidate arrays into a single flat array
  const allCandidates = [rawResults, ...hydeResults].flat();

  return {
    candidates: allCandidates,
    hydeExpanded: true,
    hydeDocCount: hypotheticalDocs.length,
  };
}

/**
 * Memory recall pipeline: hybrid search → score filtering →
 * staleness annotation → unified XML injection.
 *
 * Pipeline steps:
 *   1. Build query text (caller provides via buildMemoryQuery)
 *   2. Generate dense + sparse embeddings
 *   3. Hybrid search on Qdrant (dense + sparse RRF fusion)
 *   4. Deduplicate results
 *   5. Filter by minimum score threshold
 *   6. Enrich candidates with source labels and item metadata
 *   7. Compute staleness per item (for debugging/logging)
 *   8. Build unified XML injection with budget allocation
 */
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
  const sparseVectorAvailable = sparseVector.indices.length > 0;

  // ── Step 3: Hybrid search on Qdrant ─────────────────────────────
  const scopePolicy = config.memory.retrieval.scopePolicy;
  const scopeIds = buildScopeFilter(
    options?.scopeId,
    scopePolicy,
    options?.scopePolicyOverride,
  );

  const HYBRID_LIMIT = 40;

  let hybridCandidates: Candidate[] = [];
  let semanticSearchFailed = false;
  let sparseVectorUsed = false;
  let hydeExpanded = false;
  let hydeDocCount = 0;
  const hybridSearchStart = Date.now();

  const qdrantBreakerOpen = isQdrantBreakerOpen();
  if (queryVector && !qdrantBreakerOpen) {
    try {
      if (options?.hydeEnabled) {
        // ── HyDE path: expand query into hypothetical docs and search in parallel ──
        const hydeCandidates = await runHyDESearch(
          query,
          queryVector,
          config,
          signal,
          provider ?? "unknown",
          model ?? "unknown",
          HYBRID_LIMIT,
          excludeMessageIds,
          scopeIds,
          sparseVectorAvailable ? sparseVector : undefined,
        );
        hybridCandidates = hydeCandidates.candidates;
        hydeExpanded = hydeCandidates.hydeExpanded;
        hydeDocCount = hydeCandidates.hydeDocCount;
        sparseVectorUsed = sparseVectorAvailable;
      } else {
        // ── Standard path: single raw query search ──
        hybridCandidates = await semanticSearch(
          queryVector,
          provider ?? "unknown",
          model ?? "unknown",
          HYBRID_LIMIT,
          excludeMessageIds,
          scopeIds,
          sparseVectorAvailable ? sparseVector : undefined,
        );
        sparseVectorUsed = sparseVectorAvailable;
      }
    } catch (err) {
      semanticSearchFailed = true;
      if (isQdrantConnectionError(err)) {
        log.warn({ err }, "Qdrant unavailable — hybrid search disabled");
      } else {
        log.warn({ err }, "Hybrid search failed");
      }
    }
  }
  const hybridSearchMs = Date.now() - hybridSearchStart;

  // ── Step 4: Deduplicate ────────────────────────────────────────
  const candidateMap = new Map<string, Candidate>();
  for (const c of [...hybridCandidates]) {
    const existing = candidateMap.get(c.key);
    if (!existing) {
      candidateMap.set(c.key, { ...c });
      continue;
    }
    // Keep highest scores from each source
    existing.semantic = Math.max(existing.semantic, c.semantic);
    existing.recency = Math.max(existing.recency, c.recency);
    existing.confidence = Math.max(existing.confidence, c.confidence);
    existing.importance = Math.max(existing.importance, c.importance);
    if (c.text.length > existing.text.length) {
      existing.text = c.text;
    }
    // Propagate metadata that the first source may lack (e.g. legacy
    // Qdrant points missing conversation_id / message_id).
    if (c.conversationId && !existing.conversationId) {
      existing.conversationId = c.conversationId;
    }
    if (c.messageId && !existing.messageId) {
      existing.messageId = c.messageId;
    }
  }

  // ── Step 4b: Filter out current-conversation segments still in context ──
  // Segments whose source message is still in the conversation's context
  // window are redundant (already visible to the model). However, segments
  // from messages that were removed by context compaction should be kept —
  // those messages are no longer in the conversation history and memory is
  // the only way they can influence the response.
  let inContextMessageIds: Set<string> | null = null;
  if (conversationId) {
    inContextMessageIds = getEffectiveInContextMessageIds(conversationId);
    if (inContextMessageIds) {
      for (const [key, c] of candidateMap) {
        if (c.type === "segment") {
          if (c.messageId) {
            // Segment has a known source message — filter only if that
            // message is still in the context window.
            if (inContextMessageIds.has(c.messageId)) {
              candidateMap.delete(key);
            }
          } else if (c.conversationId === conversationId) {
            // Segment from the current conversation but missing messageId
            // (e.g. legacy Qdrant points without message_id payload).
            // We can't determine whether it's compacted, so err on the
            // side of filtering to avoid token bloat from redundant segments.
            candidateMap.delete(key);
          }
        }
      }

      // ── Item filtering: exclude items whose ALL sources are in-context ──
      // Items distilled from messages the model can already see are redundant.
      // However, items with ANY source outside the in-context set carry
      // cross-conversation information and must be preserved.
      const itemCandidateIds = [...candidateMap.values()]
        .filter((c) => c.type === "item")
        .map((c) => c.id);

      if (itemCandidateIds.length > 0) {
        try {
          const db = getDb();
          const allSources = db
            .select({
              memoryItemId: memoryItemSources.memoryItemId,
              messageId: memoryItemSources.messageId,
            })
            .from(memoryItemSources)
            .where(inArray(memoryItemSources.memoryItemId, itemCandidateIds))
            .all();

          // Build item ID → source message IDs map
          const itemSourceMap = new Map<string, string[]>();
          for (const s of allSources) {
            const existing = itemSourceMap.get(s.memoryItemId);
            if (existing) existing.push(s.messageId);
            else itemSourceMap.set(s.memoryItemId, [s.messageId]);
          }

          // Filter items whose ALL sources are in-context
          const contextIds = inContextMessageIds;
          for (const [key, c] of candidateMap) {
            if (c.type !== "item") continue;
            const sourceMessageIds = itemSourceMap.get(c.id);
            if (!sourceMessageIds || sourceMessageIds.length === 0) continue;
            if (sourceMessageIds.every((mid) => contextIds.has(mid))) {
              candidateMap.delete(key);
            }
          }
        } catch (err) {
          log.warn(
            { err },
            "Failed to fetch item sources for in-context filtering; skipping",
          );
        }
      }
    }
  }

  // Compute RRF-style final scores for the merged candidates
  const allCandidates = [...candidateMap.values()];
  for (const c of allCandidates) {
    // Multiplicative scoring: importance, confidence, and recency amplify semantic
    // relevance but can't substitute for it. An irrelevant item (semantic ≈ 0)
    // stays low regardless of metadata. Multiplier range: 0.35 (all zero) to 1.0.
    const metadataMultiplier =
      0.35 + c.importance * 0.3 + c.confidence * 0.1 + c.recency * 0.25;
    c.finalScore = c.semantic * metadataMultiplier;
  }
  allCandidates.sort((a, b) => b.finalScore - a.finalScore);

  // ── Step 5: Filter by minimum score threshold ───────────────────
  const filtered = filterByMinScore(allCandidates);

  // ── Step 5b: MMR diversity ranking ─────────────────────────────
  const mmrRanked = applyMMR(filtered, MMR_PENALTY);

  // MMR rewrites finalScore, so re-enforce the min-score threshold to
  // drop candidates whose adjusted score fell below the cutoff.
  const diversified = filterByMinScore(mmrRanked);

  // ── Step 5c: Enrich candidates with source labels ──────────────
  enrichSourceLabels(diversified);

  // ── Serendipity: sample random memories for unexpected connections ──
  const SERENDIPITY_COUNT = 3;
  const serendipityCandidates = sampleSerendipityItems(
    diversified,
    SERENDIPITY_COUNT,
    scopeIds,
  );

  // Filter serendipity items whose ALL sources are in-context (same logic
  // as Step 4b) to prevent current-turn content leaking via random sampling.
  if (inContextMessageIds && serendipityCandidates.length > 0) {
    filterInContextItems(serendipityCandidates, inContextMessageIds);
  }

  enrichSourceLabels(serendipityCandidates);

  // ── Step 6: Enrich with item metadata for staleness ─────────────
  const itemIds = diversified.filter((c) => c.type === "item").map((c) => c.id);
  const itemMetadataMap = enrichItemMetadata(itemIds);

  // ── Step 6b: Enrich item candidates with supersedes data ────────
  const itemCandidatesForSupersedes = diversified.filter(
    (c) => c.type === "item",
  );
  if (itemCandidatesForSupersedes.length > 0) {
    try {
      const db = getDb();
      const supersedesRows = db
        .select({ id: memoryItems.id, supersedes: memoryItems.supersedes })
        .from(memoryItems)
        .where(
          inArray(
            memoryItems.id,
            itemCandidatesForSupersedes.map((c) => c.id),
          ),
        )
        .all();
      const supersedesMap = new Map(
        supersedesRows.map((r) => [r.id, r.supersedes]),
      );
      for (const c of itemCandidatesForSupersedes) {
        const sup = supersedesMap.get(c.id);
        if (sup) c.supersedes = sup;
      }
    } catch (err) {
      log.warn({ err }, "Failed to enrich candidates with supersedes data");
    }
  }

  // ── Step 7: Compute staleness per item (for debugging/logging) ─
  const now = Date.now();
  for (const c of diversified) {
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

  // ── Step 8: Budget allocation and unified injection ────────────
  const maxInjectTokens = Math.max(
    1,
    Math.floor(
      options?.maxInjectTokensOverride ??
        config.memory.retrieval.maxInjectTokens,
    ),
  );

  const injectedText = buildMemoryInjection({
    candidates: diversified,
    serendipityItems: serendipityCandidates,
    totalBudgetTokens: maxInjectTokens,
  });

  // ── Assemble result ─────────────────────────────────────────────
  const selectedCount = diversified.length + serendipityCandidates.length;

  const stalenessStats = {
    fresh: diversified.filter((c) => c.staleness === "fresh").length,
    aging: diversified.filter((c) => c.staleness === "aging").length,
    stale: diversified.filter((c) => c.staleness === "stale").length,
    very_stale: diversified.filter((c) => c.staleness === "very_stale").length,
  };

  const topCandidates: MemoryRecallCandiateDebug[] = [...diversified]
    .sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, 10)
    .map((c) => ({
      key: c.key,
      type: c.type,
      kind: c.kind,
      finalScore: c.finalScore,
      semantic: c.semantic,
      recency: c.recency,
      ...(c.sourceLabel ? { sourceLabel: c.sourceLabel } : {}),
    }));

  const latencyMs = Date.now() - start;

  // Propagate degradation from semantic search failure or breaker-open skip
  if (
    semanticSearchFailed ||
    qdrantBreakerOpen ||
    (!queryVector && config.memory.embeddings.required)
  ) {
    embeddingResult.degraded = true;
    embeddingResult.reason =
      embeddingResult.reason ??
      (qdrantBreakerOpen
        ? "memory.qdrant_breaker_open"
        : "memory.hybrid_search_failure");
  }

  log.debug(
    {
      query: truncate(query, 120),
      hybridHits: hybridCandidates.length,
      mergedCount: allCandidates.length,
      stalenessStats,
      selectedCount,
      maxInjectTokens,
      injectedTokens: estimateTextTokens(injectedText),
      latencyMs,
      ...(hydeExpanded ? { hydeExpanded, hydeDocCount } : {}),
    },
    "Memory recall completed",
  );

  const result: MemoryRecallResult = {
    enabled: true,
    degraded: embeddingResult.degraded,
    degradation: embeddingResult.degradation,
    reason: embeddingResult.reason,
    provider: embeddingResult.provider,
    model: embeddingResult.model,
    semanticHits: hybridCandidates.length,
    mergedCount: allCandidates.length,
    selectedCount,
    injectedTokens: estimateTextTokens(injectedText),
    injectedText,
    latencyMs,
    topCandidates,
    tier1Count: 0,
    tier2Count: 0,
    hybridSearchMs,
    sparseVectorUsed,
    hydeExpanded,
    hydeDocCount,
    mmrApplied: true,
  };

  return result;
}

/**
 * Get the set of message IDs that are effectively in the conversation's
 * context window. This includes:
 *   1. Messages still visible (not compacted) in the conversation history.
 *   2. Fork-source message IDs — when a conversation is forked, messages are
 *      copied with new IDs but their metadata stores the original parent
 *      message ID as `forkSourceMessageId`. Segments sourced from those parent
 *      messages are redundant because the fork already contains their content.
 *
 * Uses `contextCompactedMessageCount` to determine the compaction offset:
 * messages ordered by createdAt after that count are still visible to the model.
 *
 * Returns `null` if the conversation is not found (deleted, or no DB row).
 */
function getEffectiveInContextMessageIds(
  conversationId: string,
): Set<string> | null {
  try {
    const db = getDb();

    // Look up the conversation's compacted message count
    const conv = db
      .select({
        contextCompactedMessageCount:
          conversations.contextCompactedMessageCount,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .get();

    if (!conv) return null;

    const offset = conv.contextCompactedMessageCount;

    // Fetch message IDs and metadata ordered by creation time
    const rows = db
      .select({ id: messages.id, metadata: messages.metadata })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt))
      .all();

    // Messages up to `offset` have been compacted out of context
    const inContextRows = rows.slice(offset);
    const idSet = new Set(inContextRows.map((r) => r.id));

    // Also include fork-source message IDs from in-context messages.
    // When a conversation is forked, each copied message's metadata contains
    // `forkSourceMessageId` pointing to the original (parent or grandparent)
    // message ID. Segments sourced from those original messages are redundant.
    for (const row of inContextRows) {
      if (!row.metadata) continue;
      try {
        const parsed = JSON.parse(row.metadata);
        if (
          parsed &&
          typeof parsed === "object" &&
          !Array.isArray(parsed) &&
          typeof parsed.forkSourceMessageId === "string"
        ) {
          idSet.add(parsed.forkSourceMessageId);
        }
      } catch {
        // Invalid metadata JSON — skip, don't break filtering.
      }
    }

    return idSet;
  } catch (err) {
    log.warn(
      { err },
      "Failed to fetch in-context message IDs; skipping segment filter",
    );
    return null;
  }
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

/**
 * Enrich tiered candidates with source labels (conversation titles).
 *
 * For "item" candidates: joins through memoryItemSources → messages → conversations
 * to find the most recent conversation title associated with the item.
 * For "segment" / "summary" candidates: looks up the conversation title directly
 * via the candidate's key (which contains the conversationId for segments).
 *
 * Mutates the candidates in-place for efficiency.
 */
function enrichSourceLabels(candidates: TieredCandidate[]): void {
  if (candidates.length === 0) return;

  try {
    const db = getDb();

    // ── Items: find conversation via memoryItemSources → messages → conversations ──
    const itemCandidates = candidates.filter((c) => c.type === "item");
    const itemIds = itemCandidates.map((c) => c.id);

    if (itemIds.length > 0) {
      const rows = db
        .select({
          memoryItemId: memoryItemSources.memoryItemId,
          conversationId: conversations.id,
          title: conversations.title,
          conversationCreatedAt: conversations.createdAt,
          conversationUpdatedAt: conversations.updatedAt,
        })
        .from(memoryItemSources)
        .innerJoin(
          messages,
          sql`${memoryItemSources.messageId} = ${messages.id}`,
        )
        .innerJoin(
          conversations,
          sql`${messages.conversationId} = ${conversations.id}`,
        )
        .where(inArray(memoryItemSources.memoryItemId, itemIds))
        .all();

      // Group by item ID and pick the most recently updated conversation
      const bestConvMap = new Map<
        string,
        {
          title: string | null;
          conversationId: string;
          createdAt: number;
          updatedAt: number;
        }
      >();
      for (const row of rows) {
        const existing = bestConvMap.get(row.memoryItemId);
        if (
          existing === undefined ||
          row.conversationUpdatedAt > existing.updatedAt
        ) {
          bestConvMap.set(row.memoryItemId, {
            title: row.title,
            conversationId: row.conversationId,
            createdAt: row.conversationCreatedAt,
            updatedAt: row.conversationUpdatedAt,
          });
        }
      }

      for (const c of itemCandidates) {
        const conv = bestConvMap.get(c.id);
        if (conv) {
          if (conv.title) c.sourceLabel = conv.title;
          const dirName = getConversationDirName(
            conv.conversationId,
            conv.createdAt,
          );
          c.sourcePath = `conversations/${dirName}/messages.jsonl`;
        }
      }
    }

    // ── Segments: look up conversation via conversationId on the candidate ──
    const segmentCandidates = candidates.filter(
      (c) => (c.type === "segment" || c.type === "summary") && c.conversationId,
    );

    if (segmentCandidates.length > 0) {
      const convIds = [
        ...new Set(segmentCandidates.map((c) => c.conversationId!)),
      ];
      const convRows = db
        .select({
          id: conversations.id,
          title: conversations.title,
          createdAt: conversations.createdAt,
        })
        .from(conversations)
        .where(inArray(conversations.id, convIds))
        .all();

      const convMap = new Map(convRows.map((r) => [r.id, r]));

      for (const c of segmentCandidates) {
        const conv = convMap.get(c.conversationId!);
        if (conv) {
          if (conv.title) c.sourceLabel = conv.title;
          const dirName = getConversationDirName(conv.id, conv.createdAt);
          c.sourcePath = `conversations/${dirName}/messages.jsonl`;
        }
      }
    }
  } catch (err) {
    log.warn({ err }, "Failed to enrich candidates with source labels");
  }
}

/**
 * Remove items from the array (in-place) whose ALL source messages are
 * in the given in-context set. This prevents current-turn content from
 * leaking into the injection via serendipity or other DB-sourced paths.
 */
function filterInContextItems(
  candidates: TieredCandidate[],
  inContextMessageIds: Set<string>,
): void {
  const itemIds = candidates.filter((c) => c.type === "item").map((c) => c.id);
  if (itemIds.length === 0) return;

  try {
    const db = getDb();
    const allSources = db
      .select({
        memoryItemId: memoryItemSources.memoryItemId,
        messageId: memoryItemSources.messageId,
      })
      .from(memoryItemSources)
      .where(inArray(memoryItemSources.memoryItemId, itemIds))
      .all();

    const itemSourceMap = new Map<string, string[]>();
    for (const s of allSources) {
      const existing = itemSourceMap.get(s.memoryItemId);
      if (existing) existing.push(s.messageId);
      else itemSourceMap.set(s.memoryItemId, [s.messageId]);
    }

    for (let i = candidates.length - 1; i >= 0; i--) {
      const c = candidates[i];
      if (c.type !== "item") continue;
      const sourceMessageIds = itemSourceMap.get(c.id);
      if (!sourceMessageIds || sourceMessageIds.length === 0) continue;
      if (sourceMessageIds.every((mid) => inContextMessageIds.has(mid))) {
        candidates.splice(i, 1);
      }
    }
  } catch (err) {
    log.warn(
      { err },
      "Failed to filter in-context serendipity items; skipping",
    );
  }
}

/**
 * Sample random active memory items for serendipitous recall — items
 * the user didn't ask about but might spark unexpected connections.
 *
 * Queries SQLite for random active items not already in the candidate pool,
 * then selects up to `count` items with probability proportional to their
 * importance value (importance-weighted sampling).
 *
 * Items with importance >= MIN_SERENDIPITY_IMPORTANCE are eligible, as are
 * legacy items with NULL importance (not yet backfilled). This ensures
 * genuinely significant memories and pre-importance-era items can both
 * surface as echoes.
 */
const MIN_SERENDIPITY_IMPORTANCE = 0.7;

function sampleSerendipityItems(
  existingCandidates: TieredCandidate[],
  count: number,
  scopeIds?: string[],
): TieredCandidate[] {
  if (count <= 0) return [];

  try {
    const db = getDb();

    // Collect IDs of item candidates already in the filtered set to exclude them
    const existingItemIds = existingCandidates
      .filter((c) => c.type === "item")
      .map((c) => c.id);

    const RANDOM_POOL_SIZE = 10;

    // Build scope condition: match allowed scopes, or default to 'default'
    // when no scope filter is set (prevents leaking private-scope items)
    const scopeCondition = scopeIds
      ? inArray(memoryItems.scopeId, scopeIds)
      : eq(memoryItems.scopeId, "default");

    const importanceFloor = sql`(${memoryItems.importance} >= ${MIN_SERENDIPITY_IMPORTANCE} OR ${memoryItems.importance} IS NULL)`;

    const baseConditions =
      existingItemIds.length > 0
        ? and(
            eq(memoryItems.status, "active"),
            scopeCondition,
            importanceFloor,
            notInArray(memoryItems.id, existingItemIds),
          )
        : and(
            eq(memoryItems.status, "active"),
            scopeCondition,
            importanceFloor,
          );

    // Use rowid-probe sampling instead of ORDER BY RANDOM() to avoid a
    // full-table sort whose cost grows linearly with memory_items size.
    // Strategy: get the rowid range, generate random rowids, and probe for
    // the nearest eligible row with `rowid >= ?`. Each probe is O(log n)
    // via B-tree lookup, so total cost is O(k·log n) instead of O(n·log n).
    const range = db
      .select({
        minRowid: sql<number>`MIN(rowid)`,
        maxRowid: sql<number>`MAX(rowid)`,
        total: sql<number>`COUNT(*)`,
      })
      .from(memoryItems)
      .where(baseConditions)
      .get();

    if (!range || range.total === 0) return [];

    const columns = {
      id: memoryItems.id,
      kind: memoryItems.kind,
      subject: memoryItems.subject,
      statement: memoryItems.statement,
      importance: memoryItems.importance,
      firstSeenAt: memoryItems.firstSeenAt,
    };

    let rows;
    if (range.total <= RANDOM_POOL_SIZE) {
      // Few enough eligible rows — fetch all, no randomness needed at DB level
      rows = db
        .select(columns)
        .from(memoryItems)
        .where(baseConditions)
        .all();
    } else {
      // Probe random rowids in the eligible range
      const seen = new Set<string>();
      rows = [];
      const rowidSpan = range.maxRowid - range.minRowid + 1;
      const maxAttempts = RANDOM_POOL_SIZE * 5;
      for (let i = 0; i < maxAttempts && rows.length < RANDOM_POOL_SIZE; i++) {
        const randomRowid =
          range.minRowid + Math.floor(Math.random() * rowidSpan);
        const row = db
          .select(columns)
          .from(memoryItems)
          .where(and(baseConditions, sql`rowid >= ${randomRowid}`))
          .orderBy(sql`rowid`)
          .limit(1)
          .get();
        if (row && !seen.has(row.id)) {
          seen.add(row.id);
          rows.push(row);
        }
      }
    }

    if (rows.length === 0) return [];

    // Importance-weighted sampling: sort by importance * random() descending
    // and take the top `count` items
    const weighted = rows
      .map((row) => ({
        row,
        score: (row.importance ?? 0.5) * Math.random(),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, count);

    // Convert to Candidate-compatible objects
    return weighted.map(
      ({ row }): TieredCandidate => ({
        type: "item",
        id: row.id,
        key: `item:${row.id}`,
        kind: row.kind,
        text: row.statement,
        source: "semantic",
        importance: row.importance ?? 0.5,
        confidence: 1,
        semantic: 0,
        recency: 0,
        finalScore: 0,
        createdAt: row.firstSeenAt,
      }),
    );
  } catch (err) {
    log.warn({ err }, "Failed to sample serendipity items");
    return [];
  }
}

/**
 * Inject memory recall as a text content block prepended to the last user
 * message. This follows the same pattern as workspace, temporal, and other
 * runtime injections — the memory context is a text block in the user
 * message rather than a separate synthetic message pair.
 *
 * Stripping is handled by `stripUserTextBlocksByPrefix` matching the
 * `<memory_context __injected>` prefix in `RUNTIME_INJECTION_PREFIXES`, so no
 * dedicated strip function is needed.
 */
export function injectMemoryRecallAsUserBlock(
  messages: Message[],
  memoryRecallText: string,
): Message[] {
  if (memoryRecallText.trim().length === 0) return messages;
  if (messages.length === 0) return messages;
  const userTail = messages[messages.length - 1];
  if (!userTail || userTail.role !== "user") return messages;
  return [
    ...messages.slice(0, -1),
    {
      ...userTail,
      content: [
        { type: "text" as const, text: memoryRecallText },
        ...userTail.content,
      ],
    },
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
    semanticHits: 0,
    mergedCount: 0,
    selectedCount: 0,
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
