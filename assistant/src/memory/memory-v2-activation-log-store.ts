import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getDb } from "./db-connection.js";
import { memoryV2ActivationLogs } from "./schema.js";

export interface MemoryV2ConceptRowRecord {
  slug: string;
  finalActivation: number;
  ownActivation: number;
  priorActivation: number;
  simUser: number;
  simAssistant: number;
  simNow: number;
  /**
   * Cross-encoder rerank delta in raw rerank space (`alpha · r_norm_u`)
   * for the user channel. Zero when rerank is disabled or the slug fell
   * outside the unified top-K-by-pre-rerank-A_o window. Applied
   * additively to A_o weighted by `c_user` — `simUser` itself is the
   * raw fused score and never carries the boost. Stored as a JSON field,
   * so older log rows pre-date this addition and decode with `undefined`;
   * readers should fall back to 0.
   */
  simUserRerankBoost: number;
  /**
   * Cross-encoder rerank delta for the assistant channel. Same semantics
   * as `simUserRerankBoost`, weighted by `c_assistant` when applied to
   * A_o. The NOW channel intentionally bypasses rerank, so there is no
   * `simNowRerankBoost`.
   */
  simAssistantRerankBoost: number;
  /**
   * True when rerank ran and this slug landed in the unified
   * top-K-by-pre-rerank-A_o pool. Distinguishes "cross-encoder evaluated
   * this and chose 0" from "rerank skipped this slug" so the inspector
   * can keep the rerank rows visible at `+0.000` instead of silently
   * dropping them. Older log rows pre-date this field and decode with
   * `undefined`; readers should fall back to `false`.
   */
  inRerankPool: boolean;
  spreadContribution: number;
  source: "prior_state" | "ann_top50" | "both";
  status: "in_context" | "injected" | "not_injected" | "page_missing";
}

export interface MemoryV2ConfigSnapshot {
  d: number;
  c_user: number;
  c_assistant: number;
  c_now: number;
  k: number;
  hops: number;
  top_k: number;
  epsilon: number;
}

export interface RecordMemoryV2ActivationLogParams {
  conversationId: string;
  turn: number;
  mode: "context-load" | "per-turn";
  concepts: MemoryV2ConceptRowRecord[];
  config: MemoryV2ConfigSnapshot;
}

export function recordMemoryV2ActivationLog(
  params: RecordMemoryV2ActivationLogParams,
): void {
  const db = getDb();
  // Skills now live as concept rows under `slug: "skills/<id>"`, so the
  // separate `skills_json` column is always written empty. The column itself
  // remains in the schema for backwards-compat with prior log rows; the
  // reader drops it. A future migration can DROP the column once those rows
  // age out of relevance.
  db.insert(memoryV2ActivationLogs)
    .values({
      id: uuid(),
      conversationId: params.conversationId,
      messageId: null,
      turn: params.turn,
      mode: params.mode,
      conceptsJson: JSON.stringify(params.concepts),
      skillsJson: "[]",
      configJson: JSON.stringify(params.config),
      createdAt: Date.now(),
    })
    .run();
}

export function backfillMemoryV2ActivationMessageId(
  conversationId: string,
  messageId: string,
): void {
  const db = getDb();
  db.update(memoryV2ActivationLogs)
    .set({ messageId })
    .where(
      and(
        eq(memoryV2ActivationLogs.conversationId, conversationId),
        isNull(memoryV2ActivationLogs.messageId),
      ),
    )
    .run();
}

export interface MemoryV2ActivationLog {
  conversationId: string;
  turn: number;
  mode: "context-load" | "per-turn";
  concepts: MemoryV2ConceptRowRecord[];
  config: MemoryV2ConfigSnapshot;
}

export function getMemoryV2ActivationLogByMessageIds(
  messageIds: string[],
): MemoryV2ActivationLog | null {
  if (messageIds.length === 0) return null;
  const db = getDb();
  const rows = db
    .select()
    .from(memoryV2ActivationLogs)
    .where(inArray(memoryV2ActivationLogs.messageId, messageIds))
    .orderBy(desc(memoryV2ActivationLogs.createdAt))
    .all();
  if (rows.length === 0) return null;
  const row = rows[0]!;
  return {
    conversationId: row.conversationId,
    turn: row.turn,
    mode: row.mode as "context-load" | "per-turn",
    concepts: JSON.parse(row.conceptsJson) as MemoryV2ConceptRowRecord[],
    config: JSON.parse(row.configJson) as MemoryV2ConfigSnapshot,
  };
}
