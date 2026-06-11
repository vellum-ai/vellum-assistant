import { and, asc, eq, gt, or } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getConfig } from "../config/loader.js";
import type { UsageAttributionColumns } from "../usage/attribution.js";
import { getDb } from "./db-connection.js";
import { skillLoadedEvents } from "./schema.js";

/**
 * Input for one `skill_loaded` telemetry event. Metadata only — never skill
 * output or conversation content. The attribution columns reuse the shared
 * nullable shape from `toAttributionColumns` so producers can spread it
 * directly; null and absent both persist as NULL.
 */
export interface SkillLoadedEventRecord extends Partial<UsageAttributionColumns> {
  conversationId?: string;
  skillName: string;
  /** ISO 8601 timestamp from the merged skill catalog, when known. */
  skillUpdatedAt?: string;
}

/** A persisted skill_loaded event row. */
export interface SkillLoadedEvent {
  id: string;
  createdAt: number;
  conversationId: string | null;
  skillName: string;
  skillUpdatedAt: string | null;
  provider: string | null;
  model: string | null;
  inferenceProfile: string | null;
  inferenceProfileSource: string | null;
}

/**
 * Record a `skill_loaded` telemetry event for a skill activation. No-ops when
 * usage data collection is disabled (the event is dropped to honor the
 * opt-out, matching the rest of telemetry).
 */
export function recordSkillLoadedEvent(record: SkillLoadedEventRecord): void {
  if (!getConfig().collectUsageData) return;
  const db = getDb();
  db.insert(skillLoadedEvents)
    .values({
      id: uuid(),
      createdAt: Date.now(),
      conversationId: record.conversationId,
      skillName: record.skillName,
      skillUpdatedAt: record.skillUpdatedAt,
      provider: record.provider,
      model: record.model,
      inferenceProfile: record.inferenceProfile,
      inferenceProfileSource: record.inferenceProfileSource,
    })
    .run();
}

/**
 * Query skill_loaded events that haven't been reported to telemetry yet.
 * Uses a compound cursor (createdAt + id) for reliable watermarking.
 */
export function queryUnreportedSkillLoadedEvents(
  afterCreatedAt: number,
  afterId: string | undefined,
  limit: number,
): SkillLoadedEvent[] {
  const db = getDb();
  return db
    .select({
      id: skillLoadedEvents.id,
      createdAt: skillLoadedEvents.createdAt,
      conversationId: skillLoadedEvents.conversationId,
      skillName: skillLoadedEvents.skillName,
      skillUpdatedAt: skillLoadedEvents.skillUpdatedAt,
      provider: skillLoadedEvents.provider,
      model: skillLoadedEvents.model,
      inferenceProfile: skillLoadedEvents.inferenceProfile,
      inferenceProfileSource: skillLoadedEvents.inferenceProfileSource,
    })
    .from(skillLoadedEvents)
    .where(
      afterId
        ? or(
            gt(skillLoadedEvents.createdAt, afterCreatedAt),
            and(
              eq(skillLoadedEvents.createdAt, afterCreatedAt),
              gt(skillLoadedEvents.id, afterId),
            ),
          )
        : gt(skillLoadedEvents.createdAt, afterCreatedAt),
    )
    .orderBy(asc(skillLoadedEvents.createdAt), asc(skillLoadedEvents.id))
    .limit(limit)
    .all();
}
