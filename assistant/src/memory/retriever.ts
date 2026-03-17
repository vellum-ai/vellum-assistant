import { asc, eq, inArray, sql } from "drizzle-orm";

import type { AssistantConfig } from "../config/types.js";
import { estimateTextTokens } from "../context/token-estimator.js";
import type { Message } from "../providers/types.js";
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
import { isQdrantBreakerOpen } from "./qdrant-circuit-breaker.js";
import {
  conversations,
  memoryItems,
  memoryItemSources,
  messages,
} from "./schema.js";
import {
  buildTwoLayerInjection,
  CAPABILITY_KINDS,
  IDENTITY_KINDS,
  PREFERENCE_KINDS,
} from "./search/formatting.js";
import { recencySearch } from "./search/lexical.js";
import { isQdrantConnectionError, semanticSearch } from "./search/semantic.js";
import { applyStaleDemotion, computeStaleness } from "./search/staleness.js";
import {
  classifyTiers,
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
    fallbackSources: ["recency"],
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

/**
 * Memory recall pipeline: hybrid search → tier classification →
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

  const HYBRID_LIMIT = 20;

  let hybridCandidates: Candidate[] = [];
  let semanticSearchFailed = false;
  let sparseVectorUsed = false;
  const hybridSearchStart = Date.now();

  const qdrantBreakerOpen = isQdrantBreakerOpen();
  if (queryVector && !qdrantBreakerOpen) {
    try {
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
    } catch (err) {
      semanticSearchFailed = true;
      if (isQdrantConnectionError(err)) {
        log.warn({ err }, "Qdrant unavailable — hybrid search disabled");
      } else {
        log.warn({ err }, "Hybrid search failed, continuing with recency only");
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
    existing.semantic = Math.max(existing.semantic, c.semantic);
    existing.recency = Math.max(existing.recency, c.recency);
    existing.confidence = Math.max(existing.confidence, c.confidence);
    existing.importance = Math.max(existing.importance, c.importance);
    if (c.text.length > existing.text.length) {
      existing.text = c.text;
    }
    // Propagate metadata that the first source may lack (e.g. legacy
    // Qdrant points missing conversation_id / message_id). The recency
    // source always has these from the DB, so merging fills the gap.
    if (c.conversationId && !existing.conversationId) {
      existing.conversationId = c.conversationId;
    }
    if (c.messageId && !existing.messageId) {
      existing.messageId = c.messageId;
    }
  }

  // ── Step 5b: Filter out current-conversation segments still in context ──
  // Segments whose source message is still in the conversation's context
  // window are redundant (already visible to the model). However, segments
  // from messages that were removed by context compaction should be kept —
  // those messages are no longer in the conversation history and memory is
  // the only way they can influence the response.
  if (conversationId) {
    const inContextMessageIds = getInContextMessageIds(conversationId);
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
  // Recency-only candidates (semantic=0) can never reach the tier 2 threshold
  // (>0.6) since their max finalScore is 0.3. Promote them directly to tier 2
  // so recent conversation context is preserved even without semantic signal.
  const recencyOnlyKeys = new Set(
    allCandidates
      .filter((c) => c.semantic === 0 && c.recency > 0)
      .map((c) => c.key),
  );
  const tiered = classifyTiers(allCandidates);
  if (recencyOnlyKeys.size > 0) {
    const alreadyTiered = new Set(tiered.map((c) => c.key));
    for (const c of allCandidates) {
      if (recencyOnlyKeys.has(c.key) && !alreadyTiered.has(c.key)) {
        tiered.push({ ...c, tier: 2 });
      }
    }
  }

  // ── Step 6b: Enrich candidates with source labels ──────────────
  enrichSourceLabels(tiered);

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
  const capabilities = afterDemotion.filter(
    (c) => c.tier === 1 && CAPABILITY_KINDS.has(c.kind),
  );
  const tier1Candidates = afterDemotion.filter(
    (c) =>
      c.tier === 1 &&
      !IDENTITY_KINDS.has(c.kind) &&
      !PREFERENCE_KINDS.has(c.kind) &&
      !CAPABILITY_KINDS.has(c.kind),
  );
  const tier2Candidates = afterDemotion.filter((c) => c.tier === 2);

  const injectedText = buildTwoLayerInjection({
    identityItems,
    tier1Candidates,
    tier2Candidates,
    preferences,
    capabilities,
    totalBudgetTokens: maxInjectTokens,
  });

  // ── Assemble result ─────────────────────────────────────────────
  const selectedCount =
    identityItems.length +
    tier1Candidates.length +
    tier2Candidates.length +
    preferences.length +
    capabilities.length;

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
      semantic: c.semantic,
      recency: c.recency,
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
    recencyHits: recencyCandidates.length,
    mergedCount: allCandidates.length,
    selectedCount,
    injectedTokens: estimateTextTokens(injectedText),
    injectedText,
    latencyMs,
    topCandidates,
    tier1Count,
    tier2Count,
    hybridSearchMs,
    sparseVectorUsed,
  };

  return result;
}

/**
 * Get the set of message IDs that are still in the conversation's context
 * window (i.e., not compacted away). Uses `contextCompactedMessageCount` to
 * determine the offset: messages ordered by createdAt after that count are
 * still visible to the model.
 *
 * Returns `null` if the conversation is not found (deleted, or no DB row).
 */
function getInContextMessageIds(conversationId: string): Set<string> | null {
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

    // Fetch message IDs ordered by creation time, skipping compacted ones
    const rows = db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt))
      .all();

    // Messages up to `offset` have been compacted out of context
    const inContextRows = rows.slice(offset);
    return new Set(inContextRows.map((r) => r.id));
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

    // Collect item IDs for items that need source label lookup
    const itemCandidates = candidates.filter((c) => c.type === "item");
    const itemIds = itemCandidates.map((c) => c.id);

    if (itemIds.length > 0) {
      // For items: find conversation titles via memoryItemSources → messages → conversations.
      // Pick the most recent conversation title per item.
      const rows = db
        .select({
          memoryItemId: memoryItemSources.memoryItemId,
          title: conversations.title,
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

      // Group by item ID and pick the most recently updated conversation title
      const titleMap = new Map<string, string>();
      const updatedAtMap = new Map<string, number>();
      for (const row of rows) {
        if (!row.title) continue;
        const existing = updatedAtMap.get(row.memoryItemId);
        if (existing === undefined || row.conversationUpdatedAt > existing) {
          titleMap.set(row.memoryItemId, row.title);
          updatedAtMap.set(row.memoryItemId, row.conversationUpdatedAt);
        }
      }

      for (const c of itemCandidates) {
        const title = titleMap.get(c.id);
        if (title) {
          c.sourceLabel = title;
        }
      }
    }

    // For segment candidates: the key format is "seg:<segmentId>" and the id is the segment's id.
    // We can look up the conversation title via the segment's conversationId in memory_segments.
    // However, segments already reference a conversationId in the schema — but the Candidate type
    // doesn't carry it. For now, skip segment source labels as the join path would require
    // importing memorySegments and an additional query. The primary value is item source labels.
  } catch (err) {
    log.warn({ err }, "Failed to enrich candidates with source labels");
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
    recencyHits: 0,
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
