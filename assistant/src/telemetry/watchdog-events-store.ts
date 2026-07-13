import { v4 as uuid } from "uuid";

import { getCachedShareAnalytics } from "../platform/consent-cache.js";
import { APP_VERSION } from "../version.js";
import { insertTelemetryOutboxEvent } from "./telemetry-events-outbox.js";
import type { WatchdogTelemetryEvent } from "./types.js";

/**
 * Input for one `watchdog` telemetry event. Metadata only — never conversation
 * content. `value` and `detail` are optional; omitting both yields the minimal
 * event (check_name only). `detail` is an open JSON bag carried verbatim in
 * the event payload.
 */
export interface WatchdogEventRecord {
  checkName: string;
  /** Measured magnitude (block ms, idle ms, ...). Null when the check carries no scalar. */
  value?: number | null;
  /** Open JSON bag for extra fields (reason codes, secondary numbers, ...). */
  detail?: Record<string, unknown> | null;
}

/**
 * Record a `watchdog` telemetry event for a watchdog check firing. Builds the
 * full wire event and enqueues it on the `telemetry_events` outbox. No-ops
 * when usage data collection is disabled (the event is dropped to honor the
 * opt-out, matching the rest of telemetry) or when the telemetry DB is
 * unavailable.
 */
export function recordWatchdogEvent(record: WatchdogEventRecord): void {
  if (!getCachedShareAnalytics()) {
    return;
  }
  const id = uuid();
  const createdAt = Date.now();
  const event: WatchdogTelemetryEvent = {
    type: "watchdog",
    daemon_event_id: id,
    recorded_at: createdAt,
    check_name: record.checkName,
    value: record.value ?? null,
    detail: record.detail ?? null,
    assistant_version: APP_VERSION,
  };
  insertTelemetryOutboxEvent({ id, name: "watchdog", createdAt, event });
}
