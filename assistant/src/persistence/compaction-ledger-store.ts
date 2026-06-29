import { and, desc, eq, lte } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { type DrizzleDb, getDb } from "./db-connection.js";
import { conversationCompactionEvents } from "./schema/index.js";

export interface CompactionEvent {
  /** Wall-clock time the compaction ran (= `conversations.context_compacted_at`). */
  compactedAt: number;
  summary: string;
  /** Count of leading persisted messages behind this compaction's summary. */
  compactedMessageCount: number;
}

/**
 * Append a compaction event to the ledger. Called alongside the
 * `conversations` cache update on every compaction.
 */
export function appendCompactionEvent(
  conversationId: string,
  event: CompactionEvent,
): void {
  const db = getDb();
  db.insert(conversationCompactionEvents)
    .values({
      id: uuid(),
      conversationId,
      compactedAt: event.compactedAt,
      summary: event.summary,
      compactedMessageCount: event.compactedMessageCount,
      createdAt: Date.now(),
    })
    .run();
}

/**
 * The most recent compaction event whose `compactedAt` is at-or-before
 * `atOrBefore`, or null if none (or `atOrBefore` is null). This is the fork
 * inheritance rule: a compaction applies to a fork only if it happened before
 * the message being forked from.
 */
export function getLatestCompactionEventAtOrBefore(
  conversationId: string,
  atOrBefore: number | null,
): CompactionEvent | null {
  if (atOrBefore == null) return null;
  const db = getDb();
  const row = db
    .select({
      compactedAt: conversationCompactionEvents.compactedAt,
      summary: conversationCompactionEvents.summary,
      compactedMessageCount: conversationCompactionEvents.compactedMessageCount,
    })
    .from(conversationCompactionEvents)
    .where(
      and(
        eq(conversationCompactionEvents.conversationId, conversationId),
        lte(conversationCompactionEvents.compactedAt, atOrBefore),
      ),
    )
    .orderBy(desc(conversationCompactionEvents.compactedAt))
    .limit(1)
    .get();
  return row ?? null;
}

/**
 * Copy the source conversation's ledger events with `compactedAt <=
 * boundaryCreatedAt` into the fork, so the fork owns a correct ledger for its
 * own future forks/compactions. Takes the active `db` so the copy joins the
 * caller's transaction. No-op when the boundary is null.
 */
export function forkCompactionLedger(
  db: DrizzleDb,
  sourceConversationId: string,
  forkConversationId: string,
  boundaryCreatedAt: number | null,
): void {
  if (boundaryCreatedAt == null) return;
  const events = db
    .select({
      compactedAt: conversationCompactionEvents.compactedAt,
      summary: conversationCompactionEvents.summary,
      compactedMessageCount: conversationCompactionEvents.compactedMessageCount,
    })
    .from(conversationCompactionEvents)
    .where(
      and(
        eq(conversationCompactionEvents.conversationId, sourceConversationId),
        lte(conversationCompactionEvents.compactedAt, boundaryCreatedAt),
      ),
    )
    .all();
  const now = Date.now();
  for (const event of events) {
    db.insert(conversationCompactionEvents)
      .values({
        id: uuid(),
        conversationId: forkConversationId,
        compactedAt: event.compactedAt,
        summary: event.summary,
        compactedMessageCount: event.compactedMessageCount,
        createdAt: now,
      })
      .run();
  }
}
