/**
 * Route handlers for notification delivery read endpoints.
 *
 * GET /v1/notifications/deliveries — list delivery summaries
 */

import { and, desc, eq, sql } from 'drizzle-orm';

import { getDb } from '../../memory/db.js';
import { notificationDeliveries } from '../../memory/schema.js';

/**
 * GET /v1/notifications/deliveries?assistantId=self&limit=50&offset=0
 */
export function handleListNotificationDeliveries(url: URL): Response {
  const assistantId = url.searchParams.get('assistantId');
  if (!assistantId) {
    return Response.json(
      { ok: false, error: 'assistantId query parameter is required' },
      { status: 400 },
    );
  }

  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50), 1), 200);
  const offset = Math.max(Number(url.searchParams.get('offset') ?? 0), 0);

  const db = getDb();
  const conditions = [eq(notificationDeliveries.assistantId, assistantId)];

  const rows = db
    .select({
      deliveryId: notificationDeliveries.id,
      notificationDecisionId: notificationDeliveries.notificationDecisionId,
      assistantId: notificationDeliveries.assistantId,
      channel: notificationDeliveries.channel,
      destination: notificationDeliveries.destination,
      status: notificationDeliveries.status,
      seenAt: notificationDeliveries.seenAt,
      viewedAt: notificationDeliveries.viewedAt,
      lastInteractionType: notificationDeliveries.lastInteractionType,
      lastInteractionAt: notificationDeliveries.lastInteractionAt,
      sentAt: notificationDeliveries.sentAt,
      conversationId: notificationDeliveries.conversationId,
      createdAt: notificationDeliveries.createdAt,
    })
    .from(notificationDeliveries)
    .where(and(...conditions))
    .orderBy(desc(sql`COALESCE(${notificationDeliveries.sentAt}, ${notificationDeliveries.createdAt})`))
    .limit(limit)
    .offset(offset)
    .all();

  return Response.json({
    ok: true,
    deliveries: rows,
    pagination: { limit, offset, count: rows.length },
  });
}
