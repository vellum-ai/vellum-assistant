import { v4 as uuid } from "uuid";

import { getTelemetryDb } from "../persistence/db-connection.js";
import { getCachedShareAnalytics } from "../platform/consent-cache.js";
import { insertTelemetryOutboxEvent } from "../telemetry/telemetry-events-outbox.js";
import type { AuthFallbackTelemetryEvent } from "../telemetry/types.js";
import { APP_VERSION } from "../version.js";

/** A single aggregated auth-fallback count for one (guard, path, failure_kind). */
export interface AuthFallbackCount {
  guard: string;
  path: string;
  failureKind: string;
  count: number;
}

/**
 * Record a batch of aggregated auth-fallback counts forwarded by the gateway —
 * one `telemetry_events` outbox row per count entry, all sharing the same
 * flush window, each carrying its full wire event built at record time.
 * Returns the number of rows recorded, or 0 when usage data collection is
 * disabled (the counts are dropped to honor the opt-out, matching the rest of
 * telemetry) or the telemetry database is unavailable (degraded mode). Callers
 * that must tell those apart check `getCachedShareAnalytics()` themselves.
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
  if (!getTelemetryDb()) {
    return 0;
  }
  const createdAt = Date.now();
  let recorded = 0;
  for (const c of counts) {
    const id = uuid();
    const event: AuthFallbackTelemetryEvent = {
      type: "auth_fallback",
      daemon_event_id: id,
      recorded_at: createdAt,
      guard: c.guard,
      path: c.path,
      failure_kind: c.failureKind,
      count: c.count,
      window_start: windowStart,
      window_end: windowEnd,
      assistant_version: APP_VERSION,
    };
    if (
      !insertTelemetryOutboxEvent({
        id,
        name: "auth_fallback",
        createdAt,
        event,
      })
    ) {
      // Telemetry DB went away mid-batch; report what actually landed so the
      // gateway's `recorded === 0` retry contract stays meaningful.
      return recorded;
    }
    recorded += 1;
  }
  return recorded;
}
