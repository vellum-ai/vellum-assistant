import type { UsageAttributionColumns } from "../usage/attribution.js";
import type { UsageAttributionProfileSource } from "../usage/types.js";
import { recordTelemetryEvent } from "./telemetry-events-outbox.js";

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
 * Record a `skill_loaded` telemetry event for a skill activation, enqueued on
 * the `telemetry_events` outbox with the conversation id in its dedicated
 * column so conversation deletion redacts pending rows via an indexed delete.
 * Consent gating and degraded-mode behavior are `recordTelemetryEvent`'s.
 */
export function recordSkillLoadedEvent(record: SkillLoadedEventRecord): void {
  recordTelemetryEvent(
    "skill_loaded",
    {
      skill_name: record.skillName,
      skill_updated_at: record.skillUpdatedAt ?? null,
      conversation_id: record.conversationId ?? null,
      provider: record.provider ?? null,
      model: record.model ?? null,
      inference_profile: record.inferenceProfile ?? null,
      inference_profile_source: (record.inferenceProfileSource ??
        null) as UsageAttributionProfileSource | null,
    },
    { conversationId: record.conversationId ?? null },
  );
}
