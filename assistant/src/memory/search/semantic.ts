import { inArray } from "drizzle-orm";

import { getLogger } from "../../util/logger.js";
import { getDb } from "../db.js";
import { withQdrantBreaker } from "../qdrant-circuit-breaker.js";
import type {
  QdrantSearchResult,
  QdrantSparseVector,
} from "../qdrant-client.js";
import { getQdrantClient } from "../qdrant-client.js";
import {
  conversations,
  memoryItems,
  memoryItemSources,
  memorySegments,
  memorySummaries,
} from "../schema.js";
// ── Types (inlined from deleted types.ts) ──────────────────────────

type CandidateType = "segment" | "item" | "summary" | "media";

export interface Candidate {
  key: string;
  type: CandidateType;
  id: string;
  source: "semantic";
  text: string;
  kind: string;
  modality?: "text" | "image" | "audio" | "video";
  conversationId?: string;
  messageId?: string;
  confidence: number;
  importance: number;
  createdAt: number;
  semantic: number;
  recency: number;
  finalScore: number;
}

// ── Recency scoring (inlined from deleted ranking.ts) ──────────────

/**
 * Logarithmic recency decay (ACT-R inspired).
 *
 *   1 day -> 0.50, 7 days -> 0.25, 30 days -> 0.17
 *   90 days -> 0.15, 1 year -> 0.12, 2 years -> 0.10
 */
function computeRecencyScore(createdAt: number): number {
  const ageMs = Math.max(0, Date.now() - createdAt);
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  return 1 / (1 + Math.log2(1 + ageDays));
}

const _log = getLogger("semantic-search");

export async function semanticSearch(
  queryVector: number[],
  _provider: string,
  _model: string,
  limit: number,
  excludedMessageIds: string[] = [],
  scopeIds?: string[],
  sparseVector?: QdrantSparseVector,
): Promise<Candidate[]> {
  if (limit <= 0) return [];

  const qdrant = getQdrantClient();

  // Overfetch to account for items filtered out post-query (invalidated, excluded, etc.)
  // Use 3x when exclusions are active to ensure enough results survive filtering
  const overfetchMultiplier = excludedMessageIds.length > 0 ? 3 : 2;
  const fetchLimit = limit * overfetchMultiplier;

  // When a sparse vector is available, use hybrid search (dense + sparse RRF fusion)
  // for better recall; otherwise fall back to dense-only search.
  let results: QdrantSearchResult[];
  let isHybrid = false;
  if (sparseVector && sparseVector.indices.length > 0) {
    isHybrid = true;
    const filter = buildHybridFilter(excludedMessageIds, scopeIds);
    results = await withQdrantBreaker(() =>
      qdrant.hybridSearch({
        denseVector: queryVector,
        sparseVector,
        filter,
        limit: fetchLimit,
        prefetchLimit: fetchLimit,
      }),
    );
  } else {
    results = await withQdrantBreaker(() =>
      qdrant.searchWithFilter(
        queryVector,
        fetchLimit,
        ["item", "summary", "segment", "media"],
        excludedMessageIds,
        scopeIds,
      ),
    );
  }

  const db = getDb();

  // Batch-fetch all backing records upfront to avoid N+1 queries per result
  const itemTargetIds: string[] = [];
  const summaryTargetIds: string[] = [];
  const segmentTargetIds: string[] = [];
  const mediaConversationIds: string[] = [];
  for (const r of results) {
    if (r.payload.target_type === "item")
      itemTargetIds.push(r.payload.target_id);
    else if (r.payload.target_type === "summary")
      summaryTargetIds.push(r.payload.target_id);
    else if (r.payload.target_type === "segment")
      segmentTargetIds.push(r.payload.target_id);
    else if (r.payload.target_type === "media" && r.payload.conversation_id)
      mediaConversationIds.push(r.payload.conversation_id);
  }

  const itemsMap = new Map<string, typeof memoryItems.$inferSelect>();
  if (itemTargetIds.length > 0) {
    const allItems = db
      .select()
      .from(memoryItems)
      .where(inArray(memoryItems.id, itemTargetIds))
      .all();
    for (const item of allItems) itemsMap.set(item.id, item);
  }

  const sourcesMap = new Map<string, string[]>();
  if (itemTargetIds.length > 0) {
    const allSources = db
      .select({
        memoryItemId: memoryItemSources.memoryItemId,
        messageId: memoryItemSources.messageId,
      })
      .from(memoryItemSources)
      .where(inArray(memoryItemSources.memoryItemId, itemTargetIds))
      .all();
    for (const s of allSources) {
      const existing = sourcesMap.get(s.memoryItemId);
      if (existing) existing.push(s.messageId);
      else sourcesMap.set(s.memoryItemId, [s.messageId]);
    }
  }

  const summariesMap = new Map<string, typeof memorySummaries.$inferSelect>();
  if (scopeIds && summaryTargetIds.length > 0) {
    const allSummaries = db
      .select()
      .from(memorySummaries)
      .where(inArray(memorySummaries.id, summaryTargetIds))
      .all();
    for (const s of allSummaries) summariesMap.set(s.id, s);
  }

  const segmentsMap = new Map<string, typeof memorySegments.$inferSelect>();
  if (scopeIds && segmentTargetIds.length > 0) {
    const allSegments = db
      .select()
      .from(memorySegments)
      .where(inArray(memorySegments.id, segmentTargetIds))
      .all();
    for (const seg of allSegments) segmentsMap.set(seg.id, seg);
  }

  // Batch-fetch conversation scope IDs for media results to avoid N+1 queries.
  // When a conversation is not found (deleted), its media is excluded rather than
  // falling back to "default" scope, which would leak private media.
  const mediaScopeMap = new Map<string, string>();
  if (scopeIds && mediaConversationIds.length > 0) {
    const unique = [...new Set(mediaConversationIds)];
    const rows = db
      .select({
        id: conversations.id,
        memoryScopeId: conversations.memoryScopeId,
      })
      .from(conversations)
      .where(inArray(conversations.id, unique))
      .all();
    for (const row of rows) mediaScopeMap.set(row.id, row.memoryScopeId);
  }

  const excludedSet =
    excludedMessageIds.length > 0 ? new Set(excludedMessageIds) : null;

  const candidates: Candidate[] = [];
  for (const result of results) {
    const { payload, score } = result;
    // Store raw score; hybrid RRF normalization happens after filtering
    const semantic = isHybrid ? score : mapCosineToUnit(score);
    const createdAt = payload.created_at ?? Date.now();

    if (payload.target_type === "item") {
      const item = itemsMap.get(payload.target_id);
      if (!item || item.status !== "active" || item.invalidAt != null) continue;
      if (scopeIds && !scopeIds.includes(item.scopeId)) continue;
      const sources = sourcesMap.get(payload.target_id);
      if (!sources || sources.length === 0) continue;
      if (excludedSet) {
        const hasNonExcluded = sources.some((msgId) => !excludedSet.has(msgId));
        if (!hasNonExcluded) continue;
      }
      candidates.push({
        key: `item:${payload.target_id}`,
        type: "item",
        id: payload.target_id,
        source: "semantic",
        text: `${item.subject}: ${item.statement}`,
        kind: item.kind,
        confidence: item.confidence,
        importance: item.importance ?? 0.5,
        createdAt: item.lastSeenAt,
        semantic,
        recency: computeRecencyScore(item.lastSeenAt),
        finalScore: 0,
      });
    } else if (payload.target_type === "summary") {
      if (scopeIds) {
        const summary = summariesMap.get(payload.target_id);
        if (!summary || !scopeIds.includes(summary.scopeId)) continue;
      }
      candidates.push({
        key: `summary:${payload.target_id}`,
        type: "summary",
        id: payload.target_id,
        source: "semantic",
        text: payload.text.replace(/^\[[^\]]+\]\s*/, ""),
        kind:
          payload.kind === "global" ? "global_summary" : "conversation_summary",
        confidence: 0.6,
        importance: 0.6,
        createdAt: payload.last_seen_at ?? createdAt,
        semantic,
        recency: computeRecencyScore(payload.last_seen_at ?? createdAt),
        finalScore: 0,
      });
    } else if (payload.target_type === "media") {
      // Use stored memory_scope_id when available; fall back to deriving
      // scope from conversation_id for legacy media points.
      // If the conversation was deleted, skip the media to avoid leaking
      // private media into the default scope.
      if (scopeIds) {
        let mediaScopeId: string | undefined;
        if (payload.memory_scope_id) {
          mediaScopeId = payload.memory_scope_id;
        } else if (payload.conversation_id) {
          mediaScopeId = mediaScopeMap.get(payload.conversation_id);
          if (!mediaScopeId) continue; // conversation deleted — skip
        } else {
          mediaScopeId = "default";
        }
        if (!scopeIds.includes(mediaScopeId)) continue;
      }
      candidates.push({
        key: `media:${payload.target_id}`,
        type: "media",
        id: payload.target_id,
        source: "semantic",
        text: payload.text,
        kind: payload.kind ?? "media",
        modality: payload.modality,
        confidence: 0.7,
        importance: 0.6,
        createdAt,
        semantic,
        recency: computeRecencyScore(createdAt),
        finalScore: 0,
      });
    } else {
      if (scopeIds) {
        const segment = segmentsMap.get(payload.target_id);
        if (!segment || !scopeIds.includes(segment.scopeId)) continue;
      }
      candidates.push({
        key: `segment:${payload.target_id}`,
        type: "segment",
        id: payload.target_id,
        source: "semantic",
        text: payload.text,
        kind: "segment",
        conversationId: payload.conversation_id,
        messageId: payload.message_id,
        confidence: 0.55,
        importance: 0.5,
        createdAt,
        semantic,
        recency: computeRecencyScore(createdAt),
        finalScore: 0,
      });
    }
    if (candidates.length >= limit) break;
  }

  // For hybrid search (RRF fusion), normalize semantic scores relative to
  // the surviving candidates' maximum — not the raw Qdrant batch. Filtered-out
  // high-scoring hits must not anchor normalization and deflate survivors.
  if (isHybrid && candidates.length > 0) {
    const maxScore = Math.max(...candidates.map((c) => c.semantic));
    if (maxScore > 0) {
      for (const c of candidates) {
        c.semantic = c.semantic / maxScore;
      }
    }
  }

  return candidates;
}

/**
 * Build a Qdrant filter for hybrid search. Mirrors the logic in
 * `searchWithFilter` but as a standalone object for the query API.
 *
 * Scope filtering: points with a `memory_scope_id` payload field are
 * filtered at the Qdrant level. Legacy points without the field pass
 * through and are caught by post-query DB filtering.
 */
function buildHybridFilter(
  excludeMessageIds: string[],
  scopeIds?: string[],
): Record<string, unknown> {
  const mustConditions: Array<Record<string, unknown>> = [
    {
      key: "target_type",
      match: { any: ["item", "summary", "segment", "media"] },
    },
  ];

  if (excludeMessageIds.length > 0) {
    // Only require status=active for items; segments and summaries don't have a status field
    mustConditions.push({
      should: [
        {
          must: [
            { key: "target_type", match: { value: "item" } },
            { key: "status", match: { value: "active" } },
          ],
        },
        {
          key: "target_type",
          match: { any: ["segment", "summary", "media"] },
        },
      ],
    });
  }

  // Scope filtering: accept points whose memory_scope_id matches one of the
  // allowed scopes, OR points that lack the field entirely (legacy data).
  // Post-query DB filtering remains as defense-in-depth for legacy points.
  if (scopeIds && scopeIds.length > 0) {
    mustConditions.push({
      should: [
        { key: "memory_scope_id", match: { any: scopeIds } },
        { is_empty: { key: "memory_scope_id" } },
      ],
    });
  }

  const mustNotConditions: Array<Record<string, unknown>> = [
    { key: "_meta", match: { value: true } },
  ];
  if (excludeMessageIds.length > 0) {
    mustNotConditions.push({
      key: "message_id",
      match: { any: excludeMessageIds },
    });
  }

  return {
    must: mustConditions,
    must_not: mustNotConditions,
  };
}

export function mapCosineToUnit(value: number): number {
  return Math.max(0, Math.min(1, (value + 1) / 2));
}

export function isQdrantConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|fetch failed/i.test(
    err.message,
  );
}
