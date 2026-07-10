import { and, asc, eq, gt, or } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getTelemetryDb } from "../persistence/db-connection.js";
import { configSettingEvents } from "../persistence/schema/index.js";
import { getCachedShareAnalytics } from "../platform/consent-cache.js";

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

/** A persisted config_setting event row. */
export interface ConfigSettingEvent {
  id: string;
  createdAt: number;
  configKey: string;
  configValue: string;
}

/**
 * Record a `config_setting` telemetry event. No-ops when usage data
 * collection is disabled (the event is dropped to honor the opt-out,
 * matching the rest of telemetry) — so opt-out rows never exist and the
 * reporter's standard 0 watermark default is safe.
 */
export function recordConfigSettingEvent(
  record: ConfigSettingEventRecord,
): void {
  if (!getCachedShareAnalytics()) {
    return;
  }
  const db = getTelemetryDb();
  if (!db) {
    return;
  }
  db.insert(configSettingEvents)
    .values({
      id: uuid(),
      createdAt: Date.now(),
      configKey: record.configKey.slice(0, MAX_CONFIG_KEY_CHARS),
      configValue: record.configValue.slice(0, MAX_CONFIG_VALUE_CHARS),
    })
    .run();
}

/**
 * Query config_setting events that haven't been reported to telemetry yet.
 * Uses a compound cursor (createdAt + id) for reliable watermarking.
 */
export function queryUnreportedConfigSettingEvents(
  afterCreatedAt: number,
  afterId: string | undefined,
  limit: number,
): ConfigSettingEvent[] {
  const db = getTelemetryDb();
  if (!db) {
    return [];
  }
  return db
    .select({
      id: configSettingEvents.id,
      createdAt: configSettingEvents.createdAt,
      configKey: configSettingEvents.configKey,
      configValue: configSettingEvents.configValue,
    })
    .from(configSettingEvents)
    .where(
      afterId
        ? or(
            gt(configSettingEvents.createdAt, afterCreatedAt),
            and(
              eq(configSettingEvents.createdAt, afterCreatedAt),
              gt(configSettingEvents.id, afterId),
            ),
          )
        : gt(configSettingEvents.createdAt, afterCreatedAt),
    )
    .orderBy(asc(configSettingEvents.createdAt), asc(configSettingEvents.id))
    .limit(limit)
    .all();
}
