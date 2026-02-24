/**
 * Notification event persistence.
 *
 * Each row represents a single notification signal that was emitted by
 * the system. The event captures the source event name, attention hints,
 * and context payload. Decision/delivery records are tracked separately.
 */

import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../memory/db.js';
import { notificationEvents } from '../memory/schema.js';
import type { AttentionHints } from './signal.js';

export interface NotificationEventRow {
  id: string;
  assistantId: string;
  sourceEventName: string;
  sourceChannel: string;
  sourceSessionId: string;
  attentionHintsJson: string;
  payloadJson: string;
  dedupeKey: string | null;
  createdAt: number;
  updatedAt: number;
}

function rowToEvent(row: typeof notificationEvents.$inferSelect): NotificationEventRow {
  return {
    id: row.id,
    assistantId: row.assistantId,
    sourceEventName: row.sourceEventName,
    sourceChannel: row.sourceChannel,
    sourceSessionId: row.sourceSessionId,
    attentionHintsJson: row.attentionHintsJson,
    payloadJson: row.payloadJson,
    dedupeKey: row.dedupeKey,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface CreateEventParams {
  id: string;
  assistantId: string;
  sourceEventName: string;
  sourceChannel: string;
  sourceSessionId: string;
  attentionHints: AttentionHints;
  payload: Record<string, unknown>;
  dedupeKey?: string;
}

/** Create a new notification event. Returns null if a duplicate dedupe_key exists. */
export function createEvent(params: CreateEventParams): NotificationEventRow | null {
  const db = getDb();
  const now = Date.now();

  // Normalize empty strings to null so the falsy check below and the DB
  // unique index stay in agreement (empty string is falsy in JS but would
  // be stored as a non-null value in SQLite).
  const normalizedDedupeKey = params.dedupeKey || null;

  // If there's a dedupe key, check for duplicates first
  if (normalizedDedupeKey) {
    const existing = db
      .select()
      .from(notificationEvents)
      .where(
        and(
          eq(notificationEvents.assistantId, params.assistantId),
          eq(notificationEvents.dedupeKey, normalizedDedupeKey),
        ),
      )
      .get();
    if (existing) return null;
  }

  const row = {
    id: params.id,
    assistantId: params.assistantId,
    sourceEventName: params.sourceEventName,
    sourceChannel: params.sourceChannel,
    sourceSessionId: params.sourceSessionId,
    attentionHintsJson: JSON.stringify(params.attentionHints),
    payloadJson: JSON.stringify(params.payload),
    dedupeKey: normalizedDedupeKey,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(notificationEvents).values(row).run();

  return row;
}

/** Get a single notification event by ID. */
export function getEventById(id: string): NotificationEventRow | null {
  const db = getDb();
  const row = db
    .select()
    .from(notificationEvents)
    .where(eq(notificationEvents.id, id))
    .get();
  if (!row) return null;
  return rowToEvent(row);
}

export interface ListEventsFilters {
  sourceEventName?: string;
  limit?: number;
}

/** List notification events for an assistant with optional filters. */
export function listEvents(
  assistantId: string,
  filters?: ListEventsFilters,
): NotificationEventRow[] {
  const db = getDb();
  const conditions = [eq(notificationEvents.assistantId, assistantId)];

  if (filters?.sourceEventName) {
    conditions.push(eq(notificationEvents.sourceEventName, filters.sourceEventName));
  }

  const limit = filters?.limit ?? 50;

  const rows = db
    .select()
    .from(notificationEvents)
    .where(and(...conditions))
    .orderBy(desc(notificationEvents.createdAt))
    .limit(limit)
    .all();

  return rows.map(rowToEvent);
}
