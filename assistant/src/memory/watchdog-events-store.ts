import { and, asc, eq, gt, or } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getTelemetryDb } from "../persistence/db-connection.js";
import { watchdogEvents } from "../persistence/schema/index.js";
import { getCachedShareAnalytics } from "../platform/consent-cache.js";

/**
 * Input for one `watchdog` telemetry event. Metadata only — never conversation
 * content. `value` and `detail` are optional; omitting both yields the minimal
 * event (check_name only). `detail` is a JSON bag serialized to text on persist
 * and forwarded verbatim on flush.
 */
export interface WatchdogEventRecord {
  checkName: string;
  /** Measured magnitude (block ms, idle ms, ...). Null when the check carries no scalar. */
  value?: number | null;
  /** Open JSON bag for extra fields (reason codes, secondary numbers, ...). */
  detail?: Record<string, unknown> | null;
}

/** A persisted watchdog event row. */
export interface WatchdogEvent {
  id: string;
  createdAt: number;
  checkName: string;
  value: number | null;
  /** Raw `detail` JSON text from the row, or null. Parsed by the reporter on flush. */
  detail: string | null;
}

/**
 * Record a `watchdog` telemetry event for a watchdog check firing. No-ops when
 * usage data collection is disabled (the event is dropped to honor the opt-out,
 * matching the rest of telemetry) — so opt-out rows never exist and the
 * reporter's standard 0 watermark default is safe.
 */
export function recordWatchdogEvent(record: WatchdogEventRecord): void {
  if (!getCachedShareAnalytics()) return;
  const db = getTelemetryDb();
  if (!db) return;
  db.insert(watchdogEvents)
    .values({
      id: uuid(),
      createdAt: Date.now(),
      checkName: record.checkName,
      value: record.value ?? null,
      detail: record.detail != null ? JSON.stringify(record.detail) : null,
    })
    .run();
}

/**
 * Query watchdog events that haven't been reported to telemetry yet.
 * Uses a compound cursor (createdAt + id) for reliable watermarking.
 */
export function queryUnreportedWatchdogEvents(
  afterCreatedAt: number,
  afterId: string | undefined,
  limit: number,
): WatchdogEvent[] {
  const db = getTelemetryDb();
  if (!db) return [];
  return db
    .select({
      id: watchdogEvents.id,
      createdAt: watchdogEvents.createdAt,
      checkName: watchdogEvents.checkName,
      value: watchdogEvents.value,
      detail: watchdogEvents.detail,
    })
    .from(watchdogEvents)
    .where(
      afterId
        ? or(
            gt(watchdogEvents.createdAt, afterCreatedAt),
            and(
              eq(watchdogEvents.createdAt, afterCreatedAt),
              gt(watchdogEvents.id, afterId),
            ),
          )
        : gt(watchdogEvents.createdAt, afterCreatedAt),
    )
    .orderBy(asc(watchdogEvents.createdAt), asc(watchdogEvents.id))
    .limit(limit)
    .all();
}
