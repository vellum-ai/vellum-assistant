import { v4 as uuid } from "uuid";

import { getLogger } from "./logging.js";
import { memorySqliteOrNull } from "./memory-db.js";

const log = getLogger("memory-recall-log-store");

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
  queryContext?: string;
}

export function recordMemoryRecallLog(
  params: RecordMemoryRecallLogParams,
): void {
  // Best-effort — telemetry writes must never abort the agent turn, so a
  // degraded memory connection or a failed insert only logs a warning.
  try {
    const raw = memorySqliteOrNull("recordMemoryRecallLog");
    if (!raw) {
      return;
    }
    raw
      .prepare(
        `INSERT INTO memory_recall_logs (
           id, conversation_id, message_id, enabled, degraded, provider,
           model, degradation_json, semantic_hits, merged_count,
           selected_count, tier1_count, tier2_count,
           hybrid_search_latency_ms, sparse_vector_used, injected_tokens,
           latency_ms, top_candidates_json, injected_text, reason,
           query_context, created_at
         ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        uuid(),
        params.conversationId,
        params.enabled ? 1 : 0,
        params.degraded ? 1 : 0,
        params.provider ?? null,
        params.model ?? null,
        params.degradationJson ? JSON.stringify(params.degradationJson) : null,
        params.semanticHits,
        params.mergedCount,
        params.selectedCount,
        params.tier1Count,
        params.tier2Count,
        params.hybridSearchLatencyMs,
        params.sparseVectorUsed ? 1 : 0,
        params.injectedTokens,
        params.latencyMs,
        JSON.stringify(params.topCandidatesJson),
        params.injectedText ?? null,
        params.reason ?? null,
        params.queryContext ?? null,
        Date.now(),
      );
  } catch (err) {
    log.warn({ err }, "failed to record memory recall log; continuing");
  }
}

export function backfillMemoryRecallLogMessageId(
  conversationId: string,
  messageId: string,
): void {
  try {
    const raw = memorySqliteOrNull("backfillMemoryRecallLogMessageId");
    if (!raw) {
      return;
    }
    raw
      .prepare(
        `UPDATE memory_recall_logs
           SET message_id = ?
         WHERE conversation_id = ? AND message_id IS NULL`,
      )
      .run(messageId, conversationId);
  } catch (err) {
    log.warn(
      { err },
      "failed to backfill memory recall log messageId; continuing",
    );
  }
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
  queryContext: string | null;
}

/**
 * Normalizes top-candidate entries from the stored SSE-event format
 * (key/finalScore/semantic/recency/kind) to the inspector format expected
 * by the Swift MemoryRecallCandidate struct (nodeId/score/semanticSimilarity/recencyBoost).
 * Entries already in inspector format pass through unchanged.
 */
export function normalizeTopCandidates(raw: unknown): unknown {
  if (!Array.isArray(raw)) {
    return raw;
  }
  return raw.flatMap((entry: Record<string, unknown>) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }

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

interface MemoryRecallLogRow {
  enabled: number;
  degraded: number;
  provider: string | null;
  model: string | null;
  degradation_json: string | null;
  semantic_hits: number;
  merged_count: number;
  selected_count: number;
  tier1_count: number;
  tier2_count: number;
  hybrid_search_latency_ms: number;
  sparse_vector_used: number;
  injected_tokens: number;
  latency_ms: number;
  top_candidates_json: string;
  injected_text: string | null;
  reason: string | null;
  query_context: string | null;
}

export function getMemoryRecallLogByMessageIds(
  messageIds: string[],
): MemoryRecallLog | null {
  if (messageIds.length === 0) {
    return null;
  }
  const raw = memorySqliteOrNull("getMemoryRecallLogByMessageIds");
  if (!raw) {
    return null;
  }
  const placeholders = messageIds.map(() => "?").join(",");
  const row = raw
    .query(
      `SELECT enabled, degraded, provider, model, degradation_json,
              semantic_hits, merged_count, selected_count, tier1_count,
              tier2_count, hybrid_search_latency_ms, sparse_vector_used,
              injected_tokens, latency_ms, top_candidates_json,
              injected_text, reason, query_context
         FROM memory_recall_logs
        WHERE message_id IN (${placeholders})
        LIMIT 1`,
    )
    .get(...messageIds) as MemoryRecallLogRow | null;
  if (!row) {
    return null;
  }
  return {
    enabled: !!row.enabled,
    degraded: !!row.degraded,
    provider: row.provider,
    model: row.model,
    degradation: row.degradation_json ? JSON.parse(row.degradation_json) : null,
    semanticHits: row.semantic_hits,
    mergedCount: row.merged_count,
    selectedCount: row.selected_count,
    tier1Count: row.tier1_count,
    tier2Count: row.tier2_count,
    hybridSearchLatencyMs: row.hybrid_search_latency_ms,
    sparseVectorUsed: !!row.sparse_vector_used,
    injectedTokens: row.injected_tokens,
    latencyMs: row.latency_ms,
    topCandidates: normalizeTopCandidates(JSON.parse(row.top_candidates_json)),
    injectedText: row.injected_text,
    reason: row.reason,
    queryContext: row.query_context,
  };
}
