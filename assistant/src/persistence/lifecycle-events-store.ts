import { recordTelemetryEvent } from "../telemetry/telemetry-events-outbox.js";
import type { LifecycleTelemetryEvent } from "../telemetry/types.js";
import { APP_VERSION } from "../version.js";

export interface LifecycleEvent {
  id: string;
  eventName: string;
  createdAt: number;
}

/**
 * Wire shape of one lifecycle event, for callers that insert outbox rows via
 * raw SQL (conversation-crud's clearAll audit path). Mirrors the shape
 * `recordTelemetryEvent` stamps — the shared `LifecycleTelemetryEvent` type
 * keeps them in sync.
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
 * outbox. Consent gating and degraded-mode `null` are `recordTelemetryEvent`'s.
 */
export function recordLifecycleEvent(eventName: string): LifecycleEvent | null {
  const recorded = recordTelemetryEvent("lifecycle", {
    event_name: eventName,
  });
  return recorded ? { ...recorded, eventName } : null;
}
