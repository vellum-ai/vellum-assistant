import type { UsageAttributionColumns } from "../usage/attribution.js";
import type { UsageAttributionProfileSource } from "../usage/types.js";
import { APP_VERSION } from "../version.js";
import { recordTelemetryOutboxEvent } from "./telemetry-events-outbox.js";
import type { SkillLoadedTelemetryEvent } from "./types.js";

/**
 * Input for one `skill_loaded` telemetry event. Metadata only — never skill
 * output or conversation content. The attribution columns reuse the shared
 * nullable shape from `toAttributionColumns` so producers can spread it
 * directly; null and absent both ship as null.
 */
export interface SkillLoadedEventRecord extends Partial<UsageAttributionColumns> {
  conversationId?: string;
  skillName: string;
  /** ISO 8601 timestamp from the merged skill catalog, when known. */
  skillUpdatedAt?: string;
}

/**
 * Record a `skill_loaded` telemetry event for a skill activation. The full
 * wire event (record-time `assistant_version` included) goes into the
 * `telemetry_events` outbox, with the conversation id in its dedicated
 * column so conversation deletion redacts pending rows via an indexed
 * delete. No-ops when usage data collection is disabled (the event is
 * dropped to honor the opt-out, matching the rest of telemetry) or when the
 * telemetry DB is unavailable.
 */
export function recordSkillLoadedEvent(record: SkillLoadedEventRecord): void {
  recordTelemetryOutboxEvent(
    "skill_loaded",
    (id, createdAt): SkillLoadedTelemetryEvent => ({
      type: "skill_loaded",
      daemon_event_id: id,
      recorded_at: createdAt,
      skill_name: record.skillName,
      skill_updated_at: record.skillUpdatedAt ?? null,
      conversation_id: record.conversationId ?? null,
      provider: record.provider ?? null,
      model: record.model ?? null,
      inference_profile: record.inferenceProfile ?? null,
      inference_profile_source: (record.inferenceProfileSource ??
        null) as UsageAttributionProfileSource | null,
      assistant_version: APP_VERSION,
    }),
    { conversationId: record.conversationId ?? null },
  );
}
