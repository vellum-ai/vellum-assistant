import { recordTelemetryEvent } from "./telemetry-events-outbox.js";

/**
 * Server-side bounds from the platform `ConfigSettingTelemetryEventSerializer`.
 * Values are clamped at record time so an oversize pair degrades to a
 * truncated event instead of a per-event ingest rejection.
 */
const MAX_CONFIG_KEY_CHARS = 128;
const MAX_CONFIG_VALUE_CHARS = 256;

/**
 * Input for one `config_setting` telemetry event. Metadata only — emitters
 * must record an explicit allowlist of non-sensitive settings, never
 * free-form config content, paths, or credentials.
 */
export interface ConfigSettingEventRecord {
  /** Dotted config path, e.g. `"memory.enabled"`. */
  configKey: string;
  /** Effective value rendered as a string (`"true"` / `"false"` for booleans). */
  configValue: string;
}

/**
 * Record a `config_setting` telemetry event, enqueued on the
 * `telemetry_events` outbox. Consent gating and degraded-mode behavior are
 * `recordTelemetryEvent`'s. Returns whether the event was persisted, so a
 * caller with its own dedupe memo (config-setting-snapshot.ts) only advances
 * the memo on a real write and keeps retrying while consent is off or the
 * telemetry DB is unavailable.
 */
export function recordConfigSettingEvent(
  record: ConfigSettingEventRecord,
): boolean {
  return (
    recordTelemetryEvent("config_setting", {
      config_key: record.configKey.slice(0, MAX_CONFIG_KEY_CHARS),
      config_value: record.configValue.slice(0, MAX_CONFIG_VALUE_CHARS),
    }) !== null
  );
}
