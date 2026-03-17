/**
 * Notification event persistence.
 *
 * Each row represents a single notification signal that was emitted by
 * the system. The event captures the source event name, attention hints,
 * and context payload. Decision/delivery records are tracked separately.
 */

import { and, desc, eq } from "drizzle-orm";

import { getDb } from "../memory/db.js";
import { notificationEvents } from "../memory/schema.js";
import type { AttentionHints } from "./signal.js";

export interface NotificationEventRow {
  id: string;
  sourceEventName: string;
  sourceChannel: string;
  sourceContextId: string;
  attentionHintsJson: string;
  payloadJson: string;
  dedupeKey: string | null;
  createdAt: number;
  updatedAt: number;
}

function rowToEvent(
  row: typeof notificationEvents.$inferSelect,
): NotificationEventRow {
  return {
    id: row.id,
    sourceEventName: row.sourceEventName,
    sourceChannel: row.sourceChannel,
    sourceContextId: row.sourceContextId,
    attentionHintsJson: row.attentionHintsJson,
    payloadJson: row.payloadJson,
    dedupeKey: row.dedupeKey,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface CreateEventParams {
  id: string;
  sourceEventName: string;
  sourceChannel: string;
  sourceContextId: string;
  attentionHints: AttentionHints;
  payload: Record<string, unknown>;
  dedupeKey?: string;
}

/** Create a new notification event. Returns null if a duplicate dedupe_key exists. */
export function createEvent(
  params: CreateEventParams,
): NotificationEventRow | null {
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
      .where(and(eq(notificationEvents.dedupeKey, normalizedDedupeKey)))
      .get();
    if (existing) return null;
  }

  const row = {
    id: params.id,
    sourceEventName: params.sourceEventName,
    sourceChannel: params.sourceChannel,
    sourceContextId: params.sourceContextId,
    attentionHintsJson: JSON.stringify(params.attentionHints),
    payloadJson: JSON.stringify(params.payload),
    dedupeKey: normalizedDedupeKey,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(notificationEvents).values(row).run();

  return row;
}

/** Update the dedupeKey on an existing event (e.g. when the decision engine generates one). */
export function updateEventDedupeKey(eventId: string, dedupeKey: string): void {
  const db = getDb();
  db.update(notificationEvents)
    .set({ dedupeKey, updatedAt: Date.now() })
    .where(eq(notificationEvents.id, eventId))
    .run();
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

/** List notification events with optional filters. */
export function listEvents(
  filters?: ListEventsFilters,
): NotificationEventRow[] {
  const db = getDb();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const conditions: any[] = [];

  if (filters?.sourceEventName) {
    conditions.push(
      eq(notificationEvents.sourceEventName, filters.sourceEventName),
    );
  }

  const limit = filters?.limit ?? 50;

  const query = db.select().from(notificationEvents);

  const rows = (conditions.length > 0 ? query.where(and(...conditions)) : query)
    .orderBy(desc(notificationEvents.createdAt))
    .limit(limit)
    .all();

  return rows.map(rowToEvent);
}
