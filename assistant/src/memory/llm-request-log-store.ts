import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import {
  getAssistantMessageIdsInTurn,
  getMessageById,
  messageMetadataSchema,
} from "./conversation-crud.js";
import { getDb } from "./db.js";
import { llmRequestLogs } from "./schema.js";

export function recordRequestLog(
  conversationId: string,
  requestPayload: string,
  responsePayload: string,
  messageId?: string,
  provider?: string,
): void {
  const db = getDb();
  db.insert(llmRequestLogs)
    .values({
      id: uuid(),
      conversationId,
      messageId: messageId ?? null,
      provider: provider ?? null,
      requestPayload,
      responsePayload,
      createdAt: Date.now(),
    })
    .run();
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
 * Internal helper: query `llm_request_logs` for rows matching any of the
 * given message IDs, ordered by `createdAt ASC`. Uses the existing
 * `idx_llm_request_logs_message_id` index via `inArray`.
 */
function selectLogsByMessageIds(messageIds: string[]): Array<{
  id: string;
  conversationId: string;
  messageId: string | null;
  provider: string | null;
  requestPayload: string;
  responsePayload: string;
  createdAt: number;
}> {
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

export function getRequestLogsByMessageId(messageId: string): Array<{
  id: string;
  conversationId: string;
  messageId: string | null;
  provider: string | null;
  requestPayload: string;
  responsePayload: string;
  createdAt: number;
}> {
  // Resolve all assistant message IDs in the same turn so the inspector
  // shows every LLM call from the entire agent turn, not just the queried message.
  const turnMessageIds = getAssistantMessageIdsInTurn(messageId);
  const turnLogs = selectLogsByMessageIds(turnMessageIds);
  if (turnLogs.length > 0) {
    return turnLogs;
  }

  // Fork-source fallback: if no logs found for the turn, check whether
  // the queried message was forked from a source and resolve that source's turn.
  const message = getMessageById(messageId);
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
