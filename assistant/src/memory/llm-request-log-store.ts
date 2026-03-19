import { and, eq, gte, isNull, lte } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getDb } from "./db.js";
import { llmRequestLogs } from "./schema.js";

export function recordRequestLog(
  conversationId: string,
  requestPayload: string,
  responsePayload: string,
  messageId?: string,
): void {
  const db = getDb();
  db.insert(llmRequestLogs)
    .values({
      id: uuid(),
      conversationId,
      messageId: messageId ?? null,
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

export function getRequestLogsByMessageId(messageId: string): Array<{
  id: string;
  conversationId: string;
  messageId: string | null;
  requestPayload: string;
  responsePayload: string;
  createdAt: number;
}> {
  const db = getDb();
  return db
    .select({
      id: llmRequestLogs.id,
      conversationId: llmRequestLogs.conversationId,
      messageId: llmRequestLogs.messageId,
      requestPayload: llmRequestLogs.requestPayload,
      responsePayload: llmRequestLogs.responsePayload,
      createdAt: llmRequestLogs.createdAt,
    })
    .from(llmRequestLogs)
    .where(eq(llmRequestLogs.messageId, messageId))
    .orderBy(llmRequestLogs.createdAt)
    .all();
}
