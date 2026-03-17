import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm";

import type {
  TraceEvent,
  TraceEventKind,
} from "../daemon/message-types/messages.js";
import { getDb, rawChanges } from "./db.js";
import { traceEvents } from "./schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TraceEventRow {
  eventId: string;
  conversationId: string;
  requestId?: string;
  timestampMs: number;
  sequence: number;
  kind: TraceEventKind;
  status?: "info" | "success" | "warning" | "error";
  summary: string;
  attributes?: Record<string, string | number | boolean | null>;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/** Insert a single trace event row. Duplicate eventIds are silently ignored. */
export function persistTraceEvent(event: TraceEvent): void {
  const db = getDb();
  db.insert(traceEvents)
    .values({
      eventId: event.eventId,
      conversationId: event.conversationId,
      requestId: event.requestId ?? null,
      timestampMs: event.timestampMs,
      sequence: event.sequence,
      kind: event.kind,
      status: event.status ?? null,
      summary: event.summary,
      attributesJson: event.attributes
        ? JSON.stringify(event.attributes)
        : null,
      createdAt: Date.now(),
    })
    .onConflictDoNothing()
    .run();
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** Parse a raw DB row into a TraceEventRow with deserialized attributes. */
function rowToTraceEventRow(row: {
  eventId: string;
  conversationId: string;
  requestId: string | null;
  timestampMs: number;
  sequence: number;
  kind: string;
  status: string | null;
  summary: string;
  attributesJson: string | null;
}): TraceEventRow {
  return {
    eventId: row.eventId,
    conversationId: row.conversationId,
    requestId: row.requestId ?? undefined,
    timestampMs: row.timestampMs,
    sequence: row.sequence,
    kind: row.kind as TraceEventKind,
    status: (row.status as TraceEventRow["status"]) ?? undefined,
    summary: row.summary,
    attributes: row.attributesJson
      ? (JSON.parse(row.attributesJson) as Record<
          string,
          string | number | boolean | null
        >)
      : undefined,
  };
}

/**
 * Query trace events for a conversation, ordered by sequence ASC, timestamp_ms ASC.
 * Default limit of 5000 (matching the client's retention cap).
 * Supports `afterSequence` for incremental fetching.
 */
export function getTraceEvents(
  conversationId: string,
  opts?: { limit?: number; afterSequence?: number },
): TraceEventRow[] {
  const db = getDb();
  const limit = opts?.limit ?? 5000;

  const where =
    opts?.afterSequence != null
      ? and(
          eq(traceEvents.conversationId, conversationId),
          gt(traceEvents.sequence, opts.afterSequence),
        )
      : eq(traceEvents.conversationId, conversationId);

  const rows = db
    .select()
    .from(traceEvents)
    .where(where)
    .orderBy(asc(traceEvents.sequence), asc(traceEvents.timestampMs))
    .limit(limit)
    .all();

  return rows.map(rowToTraceEventRow);
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Delete trace events older than `maxAgeDays` based on `created_at`.
 * Returns the count of deleted rows.
 */
export function deleteOldTraceEvents(maxAgeDays: number): number {
  const db = getDb();
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  db.delete(traceEvents).where(lt(traceEvents.createdAt, cutoff)).run();
  return rawChanges();
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/**
 * Return distinct conversation IDs that have trace events,
 * ordered by most recent timestamp_ms descending.
 */
export function getTraceEventConversationIds(): string[] {
  const db = getDb();
  const rows = db
    .select({ conversationId: traceEvents.conversationId })
    .from(traceEvents)
    .groupBy(traceEvents.conversationId)
    .orderBy(desc(sql`MAX(${traceEvents.timestampMs})`))
    .all();
  return rows.map((r) => r.conversationId);
}
