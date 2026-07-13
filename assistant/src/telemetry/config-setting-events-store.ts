import { v4 as uuid } from "uuid";

import { getCachedShareAnalytics } from "../platform/consent-cache.js";
import { APP_VERSION } from "../version.js";
import { insertTelemetryOutboxEvent } from "./telemetry-events-outbox.js";
import type { ConfigSettingTelemetryEvent } from "./types.js";

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
 * Record a `config_setting` telemetry event. Builds the full wire event and
 * enqueues it on the `telemetry_events` outbox. No-ops when usage data
 * collection is disabled (the event is dropped to honor the opt-out,
 * matching the rest of telemetry). Returns whether the event was persisted,
 * so a caller with its own dedupe memo (config-setting-snapshot.ts) only
 * advances the memo on a real write and keeps retrying while consent is off
 * or the telemetry DB is unavailable.
 */
export function recordConfigSettingEvent(
  record: ConfigSettingEventRecord,
): boolean {
  if (!getCachedShareAnalytics()) {
    return false;
  }
  const id = uuid();
  const createdAt = Date.now();
  const event: ConfigSettingTelemetryEvent = {
    type: "config_setting",
    daemon_event_id: id,
    recorded_at: createdAt,
    config_key: record.configKey.slice(0, MAX_CONFIG_KEY_CHARS),
    config_value: record.configValue.slice(0, MAX_CONFIG_VALUE_CHARS),
    assistant_version: APP_VERSION,
  };
  return insertTelemetryOutboxEvent({
    id,
    name: "config_setting",
    createdAt,
    event,
  });
}
