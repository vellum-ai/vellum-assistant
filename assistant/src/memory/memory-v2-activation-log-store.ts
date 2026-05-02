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
  spreadContribution: number;
  source: "prior_state" | "ann_top50" | "both";
  status: "in_context" | "injected" | "not_injected" | "page_missing";
}

export interface MemoryV2SkillRowRecord {
  id: string;
  activation: number;
  simUser: number;
  simAssistant: number;
  simNow: number;
  status: "injected" | "not_injected";
}

export interface MemoryV2ConfigSnapshot {
  d: number;
  c_user: number;
  c_assistant: number;
  c_now: number;
  k: number;
  hops: number;
  top_k: number;
  top_k_skills: number;
  epsilon: number;
}

export interface RecordMemoryV2ActivationLogParams {
  conversationId: string;
  turn: number;
  mode: "context-load" | "per-turn";
  concepts: MemoryV2ConceptRowRecord[];
  skills: MemoryV2SkillRowRecord[];
  config: MemoryV2ConfigSnapshot;
}

export function recordMemoryV2ActivationLog(
  params: RecordMemoryV2ActivationLogParams,
): void {
  const db = getDb();
  db.insert(memoryV2ActivationLogs)
    .values({
      id: uuid(),
      conversationId: params.conversationId,
      messageId: null,
      turn: params.turn,
      mode: params.mode,
      conceptsJson: JSON.stringify(params.concepts),
      skillsJson: JSON.stringify(params.skills),
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
  skills: MemoryV2SkillRowRecord[];
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
    skills: JSON.parse(row.skillsJson) as MemoryV2SkillRowRecord[],
    config: JSON.parse(row.configJson) as MemoryV2ConfigSnapshot,
  };
}
