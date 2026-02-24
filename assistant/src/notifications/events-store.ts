/**
 * Notification event persistence.
 *
 * Each row represents a single notification event that was emitted by
 * the system (e.g. a reminder fired, a schedule completed). Delivery
 * records are tracked separately in deliveries-store.ts.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '../memory/db.js';
import { notificationEvents } from '../memory/schema.js';
import type { NotificationType, NotificationDeliveryClass, NotificationChannel } from './types.js';

export interface NotificationEventRow {
  id: string;
  assistantId: string;
  notificationType: string;
  deliveryClass: string;
  sourceChannel: string;
  sourceSessionId: string;
  sourceEventId: string;
  requiresAction: boolean;
  payloadJson: string;
  dedupeKey: string | null;
  createdAt: number;
  updatedAt: number;
}

function rowToEvent(row: typeof notificationEvents.$inferSelect): NotificationEventRow {
  return {
    id: row.id,
    assistantId: row.assistantId,
    notificationType: row.notificationType,
    deliveryClass: row.deliveryClass,
    sourceChannel: row.sourceChannel,
    sourceSessionId: row.sourceSessionId,
    sourceEventId: row.sourceEventId,
    requiresAction: row.requiresAction === 1,
    payloadJson: row.payloadJson,
    dedupeKey: row.dedupeKey,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface CreateEventParams {
  id: string;
  assistantId: string;
  notificationType: NotificationType;
  deliveryClass: NotificationDeliveryClass;
  sourceChannel: NotificationChannel;
  sourceSessionId: string;
  sourceEventId: string;
  requiresAction: boolean;
  payload: Record<string, unknown>;
  dedupeKey?: string;
}

/** Create a new notification event. Returns null if a duplicate dedupe_key exists. */
export function createEvent(params: CreateEventParams): NotificationEventRow | null {
  const db = getDb();
  const now = Date.now();

  // If there's a dedupe key, check for duplicates first
  if (params.dedupeKey) {
    const existing = db
      .select()
      .from(notificationEvents)
      .where(
        and(
          eq(notificationEvents.assistantId, params.assistantId),
          eq(notificationEvents.dedupeKey, params.dedupeKey),
        ),
      )
      .get();
    if (existing) return null;
  }

  const row = {
    id: params.id,
    assistantId: params.assistantId,
    notificationType: params.notificationType,
    deliveryClass: params.deliveryClass,
    sourceChannel: params.sourceChannel,
    sourceSessionId: params.sourceSessionId,
    sourceEventId: params.sourceEventId,
    requiresAction: params.requiresAction ? 1 : 0,
    payloadJson: JSON.stringify(params.payload),
    dedupeKey: params.dedupeKey ?? null,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(notificationEvents).values(row).run();

  return {
    ...row,
    requiresAction: params.requiresAction,
  };
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
  notificationType?: NotificationType;
  limit?: number;
}

/** List notification events for an assistant with optional filters. */
export function listEvents(
  assistantId: string,
  filters?: ListEventsFilters,
): NotificationEventRow[] {
  const db = getDb();
  const conditions = [eq(notificationEvents.assistantId, assistantId)];

  if (filters?.notificationType) {
    conditions.push(eq(notificationEvents.notificationType, filters.notificationType));
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
