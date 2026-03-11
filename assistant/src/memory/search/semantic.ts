import { inArray } from "drizzle-orm";

import { getLogger } from "../../util/logger.js";
import { getDb } from "../db.js";
import {
  _getQdrantBreakerState,
  _resetQdrantBreaker,
  withQdrantBreaker,
} from "../qdrant-circuit-breaker.js";
import type { QdrantSearchResult } from "../qdrant-client.js";
import { getQdrantClient } from "../qdrant-client.js";
import { getConversationMemoryScopeId } from "../conversation-crud.js";
import {
  memoryItems,
  memoryItemSources,
  memorySegments,
  memorySummaries,
} from "../schema.js";
import { computeRecencyScore } from "./ranking.js";
import type { Candidate } from "./types.js";

const _log = getLogger("semantic-search");

// Re-export for tests that depend on these from this module
export { _getQdrantBreakerState, _resetQdrantBreaker };

export async function semanticSearch(
  queryVector: number[],
  _provider: string,
  _model: string,
  limit: number,
  excludedMessageIds: string[] = [],
  scopeIds?: string[],
): Promise<Candidate[]> {
  if (limit <= 0) return [];

  const qdrant = getQdrantClient();

  // Overfetch to account for items filtered out post-query (invalidated, excluded, etc.)
  // Use 3x when exclusions are active to ensure enough results survive filtering
  const overfetchMultiplier = excludedMessageIds.length > 0 ? 3 : 2;
  const fetchLimit = limit * overfetchMultiplier;
  const results: QdrantSearchResult[] = await withQdrantBreaker(() =>
    qdrant.searchWithFilter(
      queryVector,
      fetchLimit,
      ["item", "summary", "segment", "media"],
      excludedMessageIds,
    ),
  );

  const db = getDb();

  // Batch-fetch all backing records upfront to avoid N+1 queries per result
  const itemTargetIds: string[] = [];
  const summaryTargetIds: string[] = [];
  const segmentTargetIds: string[] = [];
  for (const r of results) {
    if (r.payload.target_type === "item")
      itemTargetIds.push(r.payload.target_id);
    else if (r.payload.target_type === "summary")
      summaryTargetIds.push(r.payload.target_id);
    else if (r.payload.target_type === "segment")
      segmentTargetIds.push(r.payload.target_id);
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

  const excludedSet =
    excludedMessageIds.length > 0 ? new Set(excludedMessageIds) : null;

  const candidates: Candidate[] = [];
  for (const result of results) {
    const { payload, score } = result;
    const semantic = mapCosineToUnit(score);
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
        lexical: 0,
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
        lexical: 0,
        semantic,
        recency: computeRecencyScore(payload.last_seen_at ?? createdAt),
        finalScore: 0,
      });
    } else if (payload.target_type === "media") {
      // Media points don't store scope_id directly in their Qdrant payload.
      // Derive scope from the conversation_id when available; treat media
      // without a conversation association as belonging to the "default" scope.
      if (scopeIds) {
        const mediaScopeId = payload.conversation_id
          ? getConversationMemoryScopeId(payload.conversation_id)
          : "default";
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
        lexical: 0,
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
        confidence: 0.55,
        importance: 0.5,
        createdAt,
        lexical: 0,
        semantic,
        recency: computeRecencyScore(createdAt),
        finalScore: 0,
      });
    }
    if (candidates.length >= limit) break;
  }
  return candidates;
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
