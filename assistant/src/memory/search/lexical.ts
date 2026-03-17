import { and, desc, eq, inArray, notInArray } from "drizzle-orm";

import { getDb } from "../db.js";
import { memorySegments } from "../schema.js";
import { computeRecencyScore } from "./ranking.js";
import type { Candidate, CandidateType } from "./types.js";

export function recencySearch(
  conversationId: string,
  limit: number,
  excludedMessageIds: string[] = [],
  scopeIds?: string[],
): Candidate[] {
  if (!conversationId || limit <= 0) return [];
  const db = getDb();
  const conditions = [eq(memorySegments.conversationId, conversationId)];
  if (excludedMessageIds.length > 0) {
    conditions.push(notInArray(memorySegments.messageId, excludedMessageIds));
  }
  if (scopeIds && scopeIds.length > 0) {
    conditions.push(inArray(memorySegments.scopeId, scopeIds));
  }
  const whereClause =
    conditions.length > 1 ? and(...conditions) : conditions[0];
  const rows = db
    .select()
    .from(memorySegments)
    .where(whereClause)
    .orderBy(desc(memorySegments.createdAt))
    .limit(limit)
    .all();
  return rows.map((row) => ({
    key: `segment:${row.id}`,
    type: "segment" as CandidateType,
    id: row.id,
    source: "recency",
    text: row.text,
    kind: "segment",
    conversationId: row.conversationId,
    confidence: 0.55,
    importance: 0.5,
    createdAt: row.createdAt,
    semantic: 0,
    recency: computeRecencyScore(row.createdAt),
    finalScore: 0,
  }));
}
