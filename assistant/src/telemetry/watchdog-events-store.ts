import { recordTelemetryEvent } from "./telemetry-events-outbox.js";

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
 * Record a `watchdog` telemetry event for a watchdog check firing, enqueued
 * on the `telemetry_events` outbox. Consent gating and degraded-mode behavior
 * are `recordTelemetryEvent`'s.
 */
export function recordWatchdogEvent(record: WatchdogEventRecord): void {
  recordTelemetryEvent("watchdog", {
    check_name: record.checkName,
    value: record.value ?? null,
    detail: record.detail ?? null,
  });
}
