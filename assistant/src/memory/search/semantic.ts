import { inArray } from "drizzle-orm";

import { getConfig } from "../../config/loader.js";
import { getDb } from "../db-connection.js";
import { withQdrantBreaker } from "../qdrant-circuit-breaker.js";
import type {
  QdrantSearchResult,
  QdrantSparseVector,
} from "../qdrant-client.js";
import { getQdrantClient } from "../qdrant-client.js";
import { memorySegments, memorySummaries } from "../schema.js";
import { mapCosineToUnit } from "../validation.js";
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

export async function semanticSearch(
  queryVector: number[],
  _provider: string,
  _model: string,
  limit: number,
  excludedMessageIds: string[] = [],
  sparseVector?: QdrantSparseVector,
): Promise<Candidate[]> {
  if (limit <= 0) return [];

  // v2 owns the read path when enabled; the v1 `memory` collection is in
  // active retirement, and routing semantic recall there would re-enter the
  // same corrupted sparse segments that can OOM-crash Qdrant.
  if (getConfig().memory.v2.enabled) return [];

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
    const filter = buildHybridFilter(excludedMessageIds);
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
        ["summary", "segment", "media"],
        excludedMessageIds,
      ),
    );
  }

  const db = getDb();

  // Batch-fetch all backing records upfront to avoid N+1 queries per result
  const summaryTargetIds: string[] = [];
  const segmentTargetIds: string[] = [];
  for (const r of results) {
    if (r.payload.target_type === "summary")
      summaryTargetIds.push(r.payload.target_id);
    else if (r.payload.target_type === "segment")
      segmentTargetIds.push(r.payload.target_id);
  }

  const summariesMap = new Map<string, typeof memorySummaries.$inferSelect>();
  if (summaryTargetIds.length > 0) {
    const allSummaries = db
      .select()
      .from(memorySummaries)
      .where(inArray(memorySummaries.id, summaryTargetIds))
      .all();
    for (const s of allSummaries) summariesMap.set(s.id, s);
  }

  const segmentsMap = new Map<string, typeof memorySegments.$inferSelect>();
  if (segmentTargetIds.length > 0) {
    const allSegments = db
      .select()
      .from(memorySegments)
      .where(inArray(memorySegments.id, segmentTargetIds))
      .all();
    for (const seg of allSegments) segmentsMap.set(seg.id, seg);
  }

  const candidates: Candidate[] = [];
  for (const result of results) {
    const { payload, score } = result;
    // Store raw score; hybrid RRF normalization happens after filtering
    const semantic = isHybrid ? score : mapCosineToUnit(score);
    const createdAt = payload.created_at ?? Date.now();

    if (payload.target_type === "item") {
      // Legacy item vectors — skip (table dropped, Qdrant cleanup pending)
      continue;
    } else if (payload.target_type === "summary") {
      if (!summariesMap.has(payload.target_id)) continue;
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
      if (!segmentsMap.has(payload.target_id)) continue;
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
 */
function buildHybridFilter(
  excludeMessageIds: string[],
): Record<string, unknown> {
  const mustConditions: Array<Record<string, unknown>> = [
    {
      key: "target_type",
      match: { any: ["summary", "segment", "media"] },
    },
  ];

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
