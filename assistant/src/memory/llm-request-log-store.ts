import { and, gte, lte, eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { getDb } from './db.js';
import { llmRequestLogs } from './schema.js';

export function recordRequestLog(
  conversationId: string,
  requestPayload: string,
  responsePayload: string,
): void {
  const db = getDb();
  db.insert(llmRequestLogs).values({
    id: uuid(),
    conversationId,
    requestPayload,
    responsePayload,
    createdAt: Date.now(),
  }).run();
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
