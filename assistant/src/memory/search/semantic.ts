import { eq } from 'drizzle-orm';
import { getDb } from '../db.js';
import { getQdrantClient } from '../qdrant-client.js';
import {
  memoryItems,
  memoryItemSources,
  memorySegments,
  memorySummaries,
} from '../schema.js';
import type { Candidate } from './types.js';
import { computeRecencyScore } from './ranking.js';

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
  const fetchLimit = limit * 2;
  const results = await qdrant.searchWithFilter(
    queryVector,
    fetchLimit,
    ['item', 'summary', 'segment'],
    excludedMessageIds,
  );

  const db = getDb();
  const candidates: Candidate[] = [];
  for (const result of results) {
    const { payload, score } = result;
    const semantic = mapCosineToUnit(score);
    const createdAt = payload.created_at ?? Date.now();

    if (payload.target_type === 'item') {
      // Validate the backing memory item is still active and has non-excluded evidence
      const item = db.select().from(memoryItems).where(eq(memoryItems.id, payload.target_id)).get();
      if (!item || item.status !== 'active' || item.invalidAt !== null) continue;
      if (scopeIds && !scopeIds.includes(item.scopeId)) continue;
      const sources = db.select().from(memoryItemSources)
        .where(eq(memoryItemSources.memoryItemId, payload.target_id)).all();
      if (sources.length === 0) continue;
      if (excludedMessageIds.length > 0) {
        const nonExcluded = sources.filter((s) => !excludedMessageIds.includes(s.messageId));
        if (nonExcluded.length === 0) continue;
      }
      candidates.push({
        key: `item:${payload.target_id}`,
        type: 'item',
        id: payload.target_id,
        source: 'semantic',
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
    } else if (payload.target_type === 'summary') {
      if (scopeIds) {
        const summary = db.select().from(memorySummaries).where(eq(memorySummaries.id, payload.target_id)).get();
        if (!summary || !scopeIds.includes(summary.scopeId)) continue;
      }
      candidates.push({
        key: `summary:${payload.target_id}`,
        type: 'summary',
        id: payload.target_id,
        source: 'semantic',
        text: payload.text.replace(/^\[[^\]]+\]\s*/, ''),
        kind: payload.kind === 'global' ? 'global_summary' : 'conversation_summary',
        confidence: 0.6,
        importance: 0.6,
        createdAt: payload.last_seen_at ?? createdAt,
        lexical: 0,
        semantic,
        recency: computeRecencyScore(payload.last_seen_at ?? createdAt),
        finalScore: 0,
      });
    } else {
      if (scopeIds) {
        const segment = db.select().from(memorySegments).where(eq(memorySegments.id, payload.target_id)).get();
        if (!segment || !scopeIds.includes(segment.scopeId)) continue;
      }
      candidates.push({
        key: `segment:${payload.target_id}`,
        type: 'segment',
        id: payload.target_id,
        source: 'semantic',
        text: payload.text,
        kind: 'segment',
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
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|fetch failed/i.test(err.message);
}
