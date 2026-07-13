import { and, asc, eq, gt, or } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getTelemetryDb } from "../persistence/db-connection.js";
import { authFallbackEvents } from "../persistence/schema/index.js";
import { getCachedShareAnalytics } from "../platform/consent-cache.js";

/** A single aggregated auth-fallback count for one (guard, path, failure_kind). */
export interface AuthFallbackCount {
  guard: string;
  path: string;
  failureKind: string;
  count: number;
}

/** A persisted auth-fallback event row. */
export interface AuthFallbackEvent {
  id: string;
  createdAt: number;
  guard: string;
  path: string;
  failureKind: string;
  count: number;
  windowStart: number;
  windowEnd: number;
}

/**
 * Record a batch of aggregated auth-fallback counts forwarded by the gateway —
 * one row per count entry, all sharing the same flush window. Returns the
 * number of rows recorded, or 0 when usage data collection is disabled (the
 * counts are dropped to honor the opt-out, matching the rest of telemetry) or
 * the telemetry database is unavailable (degraded mode). Callers that must
 * tell those apart check `getCachedShareAnalytics()` themselves.
 */
export function recordAuthFallbackCounts(
  windowStart: number,
  windowEnd: number,
  counts: AuthFallbackCount[],
): number {
  if (!getCachedShareAnalytics()) {
    return 0;
  }
  if (counts.length === 0) {
    return 0;
  }
  const db = getTelemetryDb();
  if (!db) {
    return 0;
  }
  const createdAt = Date.now();
  const rows = counts.map((c) => ({
    id: uuid(),
    createdAt,
    guard: c.guard,
    path: c.path,
    failureKind: c.failureKind,
    count: c.count,
    windowStart,
    windowEnd,
  }));
  db.insert(authFallbackEvents).values(rows).run();
  return rows.length;
}

/**
 * Query auth-fallback events that haven't been reported to telemetry yet.
 * Uses a compound cursor (createdAt + id) for reliable watermarking.
 */
export function queryUnreportedAuthFallbackEvents(
  afterCreatedAt: number,
  afterId: string | undefined,
  limit: number,
): AuthFallbackEvent[] {
  const db = getTelemetryDb();
  if (!db) {
    return [];
  }
  const rows = db
    .select({
      id: authFallbackEvents.id,
      createdAt: authFallbackEvents.createdAt,
      guard: authFallbackEvents.guard,
      path: authFallbackEvents.path,
      failureKind: authFallbackEvents.failureKind,
      count: authFallbackEvents.count,
      windowStart: authFallbackEvents.windowStart,
      windowEnd: authFallbackEvents.windowEnd,
    })
    .from(authFallbackEvents)
    .where(
      afterId
        ? or(
            gt(authFallbackEvents.createdAt, afterCreatedAt),
            and(
              eq(authFallbackEvents.createdAt, afterCreatedAt),
              gt(authFallbackEvents.id, afterId),
            ),
          )
        : gt(authFallbackEvents.createdAt, afterCreatedAt),
    )
    .orderBy(asc(authFallbackEvents.createdAt), asc(authFallbackEvents.id))
    .limit(limit)
    .all();
  return rows;
}
