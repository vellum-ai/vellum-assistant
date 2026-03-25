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

export interface MemoryRecallLogRow {
  id: string;
  conversationId: string;
  messageId: string | null;
  enabled: number;
  degraded: number;
  provider: string | null;
  model: string | null;
  degradationJson: unknown | null;
  semanticHits: number;
  mergedCount: number;
  selectedCount: number;
  tier1Count: number;
  tier2Count: number;
  hybridSearchLatencyMs: number;
  sparseVectorUsed: number;
  injectedTokens: number;
  latencyMs: number;
  topCandidatesJson: unknown;
  injectedText: string | null;
  reason: string | null;
  createdAt: number;
}

export function getMemoryRecallLogByMessageIds(
  messageIds: string[],
): MemoryRecallLogRow | null {
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
    ...row,
    degradationJson: row.degradationJson
      ? JSON.parse(row.degradationJson)
      : null,
    topCandidatesJson: JSON.parse(row.topCandidatesJson),
  };
}
