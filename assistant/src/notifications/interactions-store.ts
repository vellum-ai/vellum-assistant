/**
 * Notification delivery interaction persistence.
 *
 * Append-only interaction log plus transactional summary updates on
 * notification_deliveries. Summary invariants:
 *
 * - seen_at: first-write-wins (monotonic, never cleared once set)
 * - viewed_at: set only by explicit vellum view interactions
 * - last_interaction_*: always reflects the most recent interaction by occurred_at
 */

import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';

import { getDb } from '../memory/db.js';
import { notificationDeliveries, notificationDeliveryInteractions } from '../memory/schema.js';
import type {
  InteractionConfidence,
  InteractionSource,
  InteractionType,
  NotificationDeliverySummary,
} from './types.js';

// -- Vellum view sources ------------------------------------------------------

/**
 * Sources that represent the user actually opening or viewing the notification
 * in a vellum-controlled interface. Only interactions from these sources are
 * eligible to set `viewed_at` on the delivery summary — other explicit signals
 * (e.g. future non-vellum integrations) should only set `seen_at`.
 */
export const VELLUM_VIEW_SOURCES: ReadonlySet<InteractionSource> = new Set<InteractionSource>([
  'macos_notification_view_action',
  'macos_conversation_opened',
  'vellum_thread_opened',
]);

// -- Row type -----------------------------------------------------------------

export interface NotificationDeliveryInteractionRow {
  id: string;
  notificationDeliveryId: string;
  assistantId: string;
  channel: string;
  interactionType: string;
  confidence: string;
  source: string;
  evidenceText: string | null;
  metadataJson: string;
  occurredAt: number;
  createdAt: number;
}

// -- Params -------------------------------------------------------------------

export interface RecordInteractionParams {
  id: string;
  notificationDeliveryId: string;
  assistantId: string;
  channel: string;
  interactionType: InteractionType;
  confidence: InteractionConfidence;
  source: InteractionSource;
  evidenceText?: string;
  metadata?: Record<string, unknown>;
  occurredAt: number;
}

export interface MarkDeliverySeenParams {
  notificationDeliveryId: string;
  assistantId: string;
  channel: string;
  confidence: InteractionConfidence;
  source: InteractionSource;
  evidenceText?: string;
  occurredAt: number;
}

export interface MarkDeliveryViewedParams {
  notificationDeliveryId: string;
  assistantId: string;
  channel: string;
  source: InteractionSource;
  evidenceText?: string;
  occurredAt: number;
}

export interface GetDeliverySummariesFilters {
  assistantId: string;
  channel?: string;
  /** Only return deliveries that have at least one interaction. */
  hasInteraction?: boolean;
  limit?: number;
}

// -- Core functions -----------------------------------------------------------

/**
 * Record a delivery interaction and transactionally update the delivery
 * summary columns. Returns the persisted interaction row.
 */
export function recordNotificationDeliveryInteraction(
  params: RecordInteractionParams,
): NotificationDeliveryInteractionRow {
  const db = getDb();
  const now = Date.now();

  const row: NotificationDeliveryInteractionRow = {
    id: params.id,
    notificationDeliveryId: params.notificationDeliveryId,
    assistantId: params.assistantId,
    channel: params.channel,
    interactionType: params.interactionType,
    confidence: params.confidence,
    source: params.source,
    evidenceText: params.evidenceText ?? null,
    metadataJson: JSON.stringify(params.metadata ?? {}),
    occurredAt: params.occurredAt,
    createdAt: now,
  };

  db.transaction((tx) => {
    // 1. Insert the interaction row
    tx.insert(notificationDeliveryInteractions).values(row).run();

    // 2. Build summary updates
    const summaryUpdates: Record<string, unknown> = {
      updatedAt: now,
    };

    // seen_at: first-write-wins -- only set if not already set
    const delivery = tx
      .select({
        seenAt: notificationDeliveries.seenAt,
        viewedAt: notificationDeliveries.viewedAt,
        lastInteractionAt: notificationDeliveries.lastInteractionAt,
      })
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, params.notificationDeliveryId))
      .get();

    if (delivery && delivery.seenAt === null) {
      summaryUpdates.seenAt = params.occurredAt;
      summaryUpdates.seenConfidence = params.confidence;
      summaryUpdates.seenSource = params.source;
      summaryUpdates.seenEvidenceText = params.evidenceText ?? null;
    }

    // viewed_at: only set for explicit vellum view interactions from known sources,
    // with monotonicity guard to prevent regression on out-of-order events
    if (
      params.interactionType === 'viewed' &&
      params.confidence === 'explicit' &&
      VELLUM_VIEW_SOURCES.has(params.source) &&
      (!delivery?.viewedAt || params.occurredAt >= delivery.viewedAt)
    ) {
      summaryUpdates.viewedAt = params.occurredAt;
    }

    // last_interaction_*: update if this interaction is more recent
    if (!delivery?.lastInteractionAt || params.occurredAt >= delivery.lastInteractionAt) {
      summaryUpdates.lastInteractionAt = params.occurredAt;
      summaryUpdates.lastInteractionType = params.interactionType;
      summaryUpdates.lastInteractionConfidence = params.confidence;
      summaryUpdates.lastInteractionSource = params.source;
      summaryUpdates.lastInteractionEvidenceText = params.evidenceText ?? null;
    }

    // 3. Apply summary updates
    tx.update(notificationDeliveries)
      .set(summaryUpdates)
      .where(eq(notificationDeliveries.id, params.notificationDeliveryId))
      .run();
  });

  return row;
}

/**
 * Mark a delivery as "seen" (first-write-wins). Records a 'viewed'
 * interaction with the given confidence and source. If seen_at is
 * already set, the interaction is still logged but seen_at is not
 * overwritten.
 */
export function markDeliverySeen(params: MarkDeliverySeenParams): NotificationDeliveryInteractionRow {
  const id = crypto.randomUUID();
  return recordNotificationDeliveryInteraction({
    id,
    notificationDeliveryId: params.notificationDeliveryId,
    assistantId: params.assistantId,
    channel: params.channel,
    interactionType: 'viewed',
    confidence: params.confidence,
    source: params.source,
    evidenceText: params.evidenceText,
    occurredAt: params.occurredAt,
  });
}

/**
 * Mark a delivery as explicitly viewed in the vellum interface.
 * Sets viewed_at (explicit vellum view only) and records a 'viewed'
 * interaction with 'explicit' confidence.
 */
export function markDeliveryViewed(params: MarkDeliveryViewedParams): NotificationDeliveryInteractionRow {
  const id = crypto.randomUUID();
  return recordNotificationDeliveryInteraction({
    id,
    notificationDeliveryId: params.notificationDeliveryId,
    assistantId: params.assistantId,
    channel: params.channel,
    interactionType: 'viewed',
    confidence: 'explicit',
    source: params.source,
    evidenceText: params.evidenceText,
    occurredAt: params.occurredAt,
  });
}

/**
 * Query delivery summaries with optional filters. Returns the summary
 * projection from notification_deliveries ordered by most recent
 * interaction first, falling back to created_at.
 */
export function getNotificationDeliverySummaries(
  filters: GetDeliverySummariesFilters,
): NotificationDeliverySummary[] {
  const db = getDb();
  const conditions = [eq(notificationDeliveries.assistantId, filters.assistantId)];

  if (filters.channel) {
    conditions.push(eq(notificationDeliveries.channel, filters.channel));
  }

  if (filters.hasInteraction) {
    conditions.push(isNotNull(notificationDeliveries.lastInteractionAt));
  }

  const limit = filters.limit ?? 50;

  const rows = db
    .select({
      id: notificationDeliveries.id,
      assistantId: notificationDeliveries.assistantId,
      channel: notificationDeliveries.channel,
      seenAt: notificationDeliveries.seenAt,
      seenConfidence: notificationDeliveries.seenConfidence,
      seenSource: notificationDeliveries.seenSource,
      seenEvidenceText: notificationDeliveries.seenEvidenceText,
      viewedAt: notificationDeliveries.viewedAt,
      lastInteractionAt: notificationDeliveries.lastInteractionAt,
      lastInteractionType: notificationDeliveries.lastInteractionType,
      lastInteractionConfidence: notificationDeliveries.lastInteractionConfidence,
      lastInteractionSource: notificationDeliveries.lastInteractionSource,
      lastInteractionEvidenceText: notificationDeliveries.lastInteractionEvidenceText,
    })
    .from(notificationDeliveries)
    .where(and(...conditions))
    .orderBy(desc(sql`COALESCE(${notificationDeliveries.lastInteractionAt}, ${notificationDeliveries.createdAt})`))
    .limit(limit)
    .all();

  return rows;
}
