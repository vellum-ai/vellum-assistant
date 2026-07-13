import { v4 as uuid } from "uuid";

import { getCachedShareAnalytics } from "../platform/consent-cache.js";
import { insertTelemetryOutboxEvent } from "../telemetry/telemetry-events-outbox.js";
import type { LifecycleTelemetryEvent } from "../telemetry/types.js";
import { APP_VERSION } from "../version.js";

export interface LifecycleEvent {
  id: string;
  eventName: string;
  createdAt: number;
}

/**
 * Wire shape of one lifecycle event, stamped with the record-time binary's
 * `APP_VERSION` (the outbox stores the full wire payload at record time).
 */
export function buildLifecycleTelemetryEvent(
  id: string,
  eventName: string,
  createdAt: number,
): LifecycleTelemetryEvent {
  return {
    type: "lifecycle",
    daemon_event_id: id,
    event_name: eventName,
    recorded_at: createdAt,
    assistant_version: APP_VERSION,
  };
}

/**
 * Record a lifecycle event (e.g. app_open, hatch) into the `telemetry_events`
 * outbox. Returns null when usage data collection is disabled or the
 * telemetry database is unavailable (degraded mode).
 */
export function recordLifecycleEvent(eventName: string): LifecycleEvent | null {
  if (!getCachedShareAnalytics()) {
    return null;
  }
  const event: LifecycleEvent = {
    id: uuid(),
    eventName,
    createdAt: Date.now(),
  };
  const inserted = insertTelemetryOutboxEvent({
    id: event.id,
    name: "lifecycle",
    createdAt: event.createdAt,
    event: buildLifecycleTelemetryEvent(event.id, eventName, event.createdAt),
  });
  return inserted ? event : null;
}
