import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import {
  getAssistantMessageIdsInTurn,
  getMessageById,
  getTurnTimeBounds,
  messageMetadataSchema,
} from "./conversation-crud.js";
import { getDb } from "./db.js";
import { llmRequestLogs, messages } from "./schema.js";

type LogRow = {
  id: string;
  conversationId: string;
  messageId: string | null;
  provider: string | null;
  requestPayload: string;
  responsePayload: string;
  createdAt: number;
};

export function recordRequestLog(
  conversationId: string,
  requestPayload: string,
  responsePayload: string,
  messageId?: string,
  provider?: string,
): string {
  const db = getDb();
  const id = uuid();
  db.insert(llmRequestLogs)
    .values({
      id,
      conversationId,
      messageId: messageId ?? null,
      provider: provider ?? null,
      requestPayload,
      responsePayload,
      createdAt: Date.now(),
    })
    .run();
  return id;
}

export function queryRequestLogs(
  conversationId: string,
  startTime: number,
  endTime: number,
): Array<{
  id: string;
  conversationId: string;
  requestPayload: string;
  responsePayload: string;
  createdAt: number;
}> {
  const db = getDb();
  return db
    .select()
    .from(llmRequestLogs)
    .where(
      and(
        eq(llmRequestLogs.conversationId, conversationId),
        gte(llmRequestLogs.createdAt, startTime),
        lte(llmRequestLogs.createdAt, endTime),
      ),
    )
    .orderBy(llmRequestLogs.createdAt)
    .all();
}

export function backfillMessageIdOnLogs(
  conversationId: string,
  messageId: string,
): void {
  const db = getDb();
  db.update(llmRequestLogs)
    .set({ messageId })
    .where(
      and(
        eq(llmRequestLogs.conversationId, conversationId),
        isNull(llmRequestLogs.messageId),
      ),
    )
    .run();
}

/**
 * Set `messageId` on specific log rows identified by their IDs.
 * Unlike `backfillMessageIdOnLogs` (which updates all null-messageId rows
 * for a conversation), this targets only the given log rows — safe for
 * concurrent watch/assistant turns.
 */
export function setMessageIdOnLogs(
  logIds: string[],
  messageId: string,
): void {
  if (logIds.length === 0) return;
  const db = getDb();
  db.update(llmRequestLogs)
    .set({ messageId })
    .where(inArray(llmRequestLogs.id, logIds))
    .run();
}

/**
 * Re-link LLM request logs from a set of source message IDs to a target
 * message. Used during message consolidation so logs from deleted
 * intermediate messages survive and remain queryable via the consolidated
 * message.
 */
export function relinkLlmRequestLogs(
  fromMessageIds: string[],
  toMessageId: string,
): void {
  if (fromMessageIds.length === 0) return;
  const db = getDb();
  db.update(llmRequestLogs)
    .set({ messageId: toMessageId })
    .where(inArray(llmRequestLogs.messageId, fromMessageIds))
    .run();
}

/**
 * Internal helper: query `llm_request_logs` for rows matching any of the
 * given message IDs, ordered by `createdAt ASC`. Uses the existing
 * `idx_llm_request_logs_message_id` index via `inArray`.
 */
function selectLogsByMessageIds(messageIds: string[]): LogRow[] {
  if (messageIds.length === 0) return [];
  const db = getDb();
  return db
    .select({
      id: llmRequestLogs.id,
      conversationId: llmRequestLogs.conversationId,
      messageId: llmRequestLogs.messageId,
      provider: llmRequestLogs.provider,
      requestPayload: llmRequestLogs.requestPayload,
      responsePayload: llmRequestLogs.responsePayload,
      createdAt: llmRequestLogs.createdAt,
    })
    .from(llmRequestLogs)
    .where(inArray(llmRequestLogs.messageId, messageIds))
    .orderBy(llmRequestLogs.createdAt)
    .all();
}

/**
 * Find orphaned logs — logs whose `message_id` references a message that no
 * longer exists in the DB. These are left behind when intermediate assistant
 * messages are deleted (e.g. by retry/deleteLastExchange).
 *
 * Scoped to a single conversation and a time range to avoid cross-turn bleed.
 */
function selectOrphanedLogsInRange(
  conversationId: string,
  startTime: number,
  endTime: number,
): LogRow[] {
  if (endTime <= startTime) return [];
  const db = getDb();
  // LEFT JOIN messages → filter where message row IS NULL (orphaned).
  return db
    .select({
      id: llmRequestLogs.id,
      conversationId: llmRequestLogs.conversationId,
      messageId: llmRequestLogs.messageId,
      provider: llmRequestLogs.provider,
      requestPayload: llmRequestLogs.requestPayload,
      responsePayload: llmRequestLogs.responsePayload,
      createdAt: llmRequestLogs.createdAt,
    })
    .from(llmRequestLogs)
    .leftJoin(messages, eq(llmRequestLogs.messageId, messages.id))
    .where(
      and(
        eq(llmRequestLogs.conversationId, conversationId),
        gte(llmRequestLogs.createdAt, startTime),
        lte(llmRequestLogs.createdAt, endTime),
        sql`${messages.id} IS NULL`,
        sql`${llmRequestLogs.messageId} IS NOT NULL`,
      ),
    )
    .orderBy(llmRequestLogs.createdAt)
    .all();
}

export function getRequestLogsByMessageId(messageId: string): LogRow[] {
  // Resolve all assistant message IDs in the same turn so the inspector
  // shows every LLM call from the entire agent turn, not just the queried message.
  const turnMessageIds = getAssistantMessageIdsInTurn(messageId);
  const turnLogs = selectLogsByMessageIds(turnMessageIds);

  // Orphaned-log recovery: intermediate assistant messages within a turn can
  // be deleted (e.g. by retry / deleteLastExchange) while their
  // llm_request_logs rows survive. When that happens the message-ID-based
  // query misses those logs. We detect orphaned logs (logs whose message_id
  // references a deleted message) within the turn's time window and merge
  // them with the message-ID-based results.
  const message = getMessageById(messageId);
  if (message) {
    const bounds = getTurnTimeBounds(message.conversationId, message.createdAt);
    if (bounds) {
      const orphanedLogs = selectOrphanedLogsInRange(
        message.conversationId,
        bounds.startTime,
        bounds.endTime,
      );
      if (orphanedLogs.length > 0) {
        const seen = new Set(turnLogs.map((l) => l.id));
        const merged = [...turnLogs];
        for (const log of orphanedLogs) {
          if (!seen.has(log.id)) {
            merged.push(log);
            seen.add(log.id);
          }
        }
        merged.sort(
          (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
        );
        return merged;
      }
    }
  }

  if (turnLogs.length > 0) {
    return turnLogs;
  }

  // Fork-source fallback: if no logs found for the turn, check whether
  // the queried message was forked from a source and resolve that source's turn.
  if (!message?.metadata) {
    return [];
  }

  try {
    const parsed = messageMetadataSchema.safeParse(
      JSON.parse(message.metadata),
    );
    const sourceMessageId =
      parsed.success && typeof parsed.data.forkSourceMessageId === "string"
        ? parsed.data.forkSourceMessageId
        : null;
    if (!sourceMessageId || sourceMessageId === messageId) {
      return [];
    }
    const sourceTurnIds = getAssistantMessageIdsInTurn(sourceMessageId);
    return selectLogsByMessageIds(sourceTurnIds);
  } catch {
    return [];
  }
}
