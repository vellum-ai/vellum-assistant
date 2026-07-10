import { and, asc, eq, gt, or } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getCachedShareAnalytics } from "../platform/consent-cache.js";
import { getTelemetryDb } from "./db-connection.js";
import { lifecycleEvents } from "./schema.js";

export interface LifecycleEvent {
  id: string;
  eventName: string;
  createdAt: number;
}

/**
 * Record a lifecycle event (e.g. app_open, hatch). Returns null when usage
 * data collection is disabled or the telemetry database is unavailable
 * (degraded mode).
 */
export function recordLifecycleEvent(eventName: string): LifecycleEvent | null {
  if (!getCachedShareAnalytics()) {
    return null;
  }
  const db = getTelemetryDb();
  if (!db) {
    return null;
  }
  const event: LifecycleEvent = {
    id: uuid(),
    eventName,
    createdAt: Date.now(),
  };
  db.insert(lifecycleEvents)
    .values({
      id: event.id,
      eventName: event.eventName,
      createdAt: event.createdAt,
    })
    .run();
  return event;
}

/**
 * Query lifecycle events that haven't been reported to telemetry yet.
 * Uses a compound cursor (createdAt + id) for reliable watermarking.
 */
export function queryUnreportedLifecycleEvents(
  afterCreatedAt: number,
  afterId: string | undefined,
  limit: number,
): LifecycleEvent[] {
  const db = getTelemetryDb();
  if (!db) {
    return [];
  }
  const rows = db
    .select({
      id: lifecycleEvents.id,
      eventName: lifecycleEvents.eventName,
      createdAt: lifecycleEvents.createdAt,
    })
    .from(lifecycleEvents)
    .where(
      afterId
        ? or(
            gt(lifecycleEvents.createdAt, afterCreatedAt),
            and(
              eq(lifecycleEvents.createdAt, afterCreatedAt),
              gt(lifecycleEvents.id, afterId),
            ),
          )
        : gt(lifecycleEvents.createdAt, afterCreatedAt),
    )
    .orderBy(asc(lifecycleEvents.createdAt), asc(lifecycleEvents.id))
    .limit(limit)
    .all();
  return rows;
}
