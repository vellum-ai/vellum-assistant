import { and, eq, inArray, isNull } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getDb } from "./db.js";
import { memoryRecallLogs } from "./schema.js";

export interface RecordMemoryRecallLogParams {
  conversationId: string;
  enabled: boolean;
  degraded: boolean;
  provider?: string;
  model?: string;
  degradationJson?: unknown;
  semanticHits: number;
  mergedCount: number;
  selectedCount: number;
  tier1Count: number;
  tier2Count: number;
  hybridSearchLatencyMs: number;
  sparseVectorUsed: boolean;
  injectedTokens: number;
  latencyMs: number;
  topCandidatesJson: unknown;
  injectedText?: string;
  reason?: string;
}

export function recordMemoryRecallLog(params: RecordMemoryRecallLogParams): void {
  const db = getDb();
  db.insert(memoryRecallLogs)
    .values({
      id: uuid(),
      conversationId: params.conversationId,
      messageId: null,
      enabled: params.enabled ? 1 : 0,
      degraded: params.degraded ? 1 : 0,
      provider: params.provider ?? null,
      model: params.model ?? null,
      degradationJson: params.degradationJson
        ? JSON.stringify(params.degradationJson)
        : null,
      semanticHits: params.semanticHits,
      mergedCount: params.mergedCount,
      selectedCount: params.selectedCount,
      tier1Count: params.tier1Count,
      tier2Count: params.tier2Count,
      hybridSearchLatencyMs: params.hybridSearchLatencyMs,
      sparseVectorUsed: params.sparseVectorUsed ? 1 : 0,
      injectedTokens: params.injectedTokens,
      latencyMs: params.latencyMs,
      topCandidatesJson: JSON.stringify(params.topCandidatesJson),
      injectedText: params.injectedText ?? null,
      reason: params.reason ?? null,
      createdAt: Date.now(),
    })
    .run();
}

export function backfillMemoryRecallLogMessageId(
  conversationId: string,
  messageId: string,
): void {
  const db = getDb();
  db.update(memoryRecallLogs)
    .set({ messageId })
    .where(
      and(
        eq(memoryRecallLogs.conversationId, conversationId),
        isNull(memoryRecallLogs.messageId),
      ),
    )
    .run();
}

export interface MemoryRecallLog {
  enabled: boolean;
  degraded: boolean;
  provider: string | null;
  model: string | null;
  degradation: unknown | null;
  semanticHits: number;
  mergedCount: number;
  selectedCount: number;
  tier1Count: number;
  tier2Count: number;
  hybridSearchLatencyMs: number;
  sparseVectorUsed: boolean;
  injectedTokens: number;
  latencyMs: number;
  topCandidates: unknown;
  injectedText: string | null;
  reason: string | null;
}

/**
 * Normalizes top-candidate entries from the stored SSE-event format
 * (key/finalScore/semantic/recency/kind) to the inspector format expected
 * by the Swift MemoryRecallCandidate struct (nodeId/score/semanticSimilarity/recencyBoost).
 * Entries already in inspector format pass through unchanged.
 */
export function normalizeTopCandidates(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw.flatMap((entry: Record<string, unknown>) => {
    if (!entry || typeof entry !== "object") return [];

    // Start with a shallow copy, then apply field renames
    const { key, finalScore, semantic, recency, kind: _kind, ...rest } = entry;

    // nodeId: prefer existing nodeId, fall back to key
    if (rest.nodeId === undefined && key !== undefined) {
      rest.nodeId = key;
    }

    // score: prefer existing score, fall back to finalScore
    if (rest.score === undefined && finalScore !== undefined) {
      rest.score = finalScore;
    }

    // semanticSimilarity: prefer existing, fall back to semantic
    if (rest.semanticSimilarity === undefined && semantic !== undefined) {
      rest.semanticSimilarity = semantic;
    }

    // recencyBoost: prefer existing, fall back to recency
    if (rest.recencyBoost === undefined && recency !== undefined) {
      rest.recencyBoost = recency;
    }

    // kind is stripped (not in the Swift model) — already excluded via destructuring

    return rest;
  });
}

export function getMemoryRecallLogByMessageIds(
  messageIds: string[],
): MemoryRecallLog | null {
  if (messageIds.length === 0) return null;
  const db = getDb();
  const rows = db
    .select()
    .from(memoryRecallLogs)
    .where(inArray(memoryRecallLogs.messageId, messageIds))
    .all();
  if (rows.length === 0) return null;
  const row = rows[0]!;
  return {
    enabled: !!row.enabled,
    degraded: !!row.degraded,
    provider: row.provider,
    model: row.model,
    degradation: row.degradationJson
      ? JSON.parse(row.degradationJson)
      : null,
    semanticHits: row.semanticHits,
    mergedCount: row.mergedCount,
    selectedCount: row.selectedCount,
    tier1Count: row.tier1Count,
    tier2Count: row.tier2Count,
    hybridSearchLatencyMs: row.hybridSearchLatencyMs,
    sparseVectorUsed: !!row.sparseVectorUsed,
    injectedTokens: row.injectedTokens,
    latencyMs: row.latencyMs,
    topCandidates: normalizeTopCandidates(JSON.parse(row.topCandidatesJson)),
    injectedText: row.injectedText,
    reason: row.reason,
  };
}
