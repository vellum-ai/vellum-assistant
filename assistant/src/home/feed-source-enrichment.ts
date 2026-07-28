/**
 * Read-time enrichment of home-feed items with their source-conversation
 * classification.
 *
 * The activity feed surfaces notifications produced by many background
 * flows — the periodic heartbeat, memory-consolidation passes, each
 * recurring schedule, auto-analysis runs, etc. Clients let the user filter
 * the feed by that producer, so every item is tagged with:
 *
 *   - `sourceType`  — coarse producer category.
 *   - `sourceKey`   — stable filter id (`schedule:<id>` per schedule,
 *                     otherwise the `sourceType`).
 *   - `sourceLabel` — human-readable display (a schedule's name, or a
 *                     static label such as "Heartbeat").
 *
 * The classification is derived from the source conversation's `source`
 * column (and, for schedules, its name) rather than persisted onto the
 * feed item. Resolving at read time keeps labels fresh across schedule
 * renames and retroactively classifies items written before this feature
 * existed, with no migration.
 *
 * The lookups are injectable so the enrichment can be unit-tested without
 * a live database; production callers use the defaults.
 */

import {
  type FeedItem,
  type FeedItemSourceType,
} from "../api/responses/home.js";
import { AUTO_ANALYSIS_SOURCE } from "../persistence/auto-analysis-constants.js";
import { getConversation } from "../persistence/conversation-crud.js";
import {
  MEMORY_RETROSPECTIVE_FORK_SOURCE,
  MEMORY_RETROSPECTIVE_SOURCE,
} from "../plugins/defaults/memory/memory-retrospective-constants.js";
import { getSchedule } from "../schedule/schedule-store.js";

/** Minimal source-conversation shape the enrichment needs. */
interface ConversationSourceRow {
  source: string;
  scheduleJobId: string | null;
}

export interface FeedSourceEnrichmentDeps {
  /** Resolve the source columns for a conversation, or null when missing. */
  getConversationRow?: (id: string) => ConversationSourceRow | null;
  /** Resolve a schedule's display name, or null when missing. */
  getScheduleName?: (id: string) => string | null;
}

/**
 * Map a conversation's `source` column to a coarse feed source type.
 * Mechanical mapping over the known producer sources; anything else
 * (including the broadcaster's paired `"notification"` delivery
 * conversations) falls through to `"other"`.
 */
export function classifyConversationSource(
  source: string | null | undefined,
): FeedItemSourceType {
  switch (source) {
    case "heartbeat":
      return "heartbeat";
    case MEMORY_RETROSPECTIVE_SOURCE:
    case MEMORY_RETROSPECTIVE_FORK_SOURCE:
      return "memory_consolidation";
    case "schedule":
      return "schedule";
    case AUTO_ANALYSIS_SOURCE:
      return "auto_analysis";
    case "user":
    case "home-feed":
      return "user";
    default:
      return "other";
  }
}

/** Static display labels for non-schedule source types. */
const STATIC_SOURCE_LABELS: Record<
  Exclude<FeedItemSourceType, "schedule">,
  string
> = {
  heartbeat: "Heartbeat",
  memory_consolidation: "Memory consolidation",
  auto_analysis: "Auto-analysis",
  user: "Conversation",
  other: "Other",
};

function defaultGetConversationRow(id: string): ConversationSourceRow | null {
  try {
    const row = getConversation(id);
    return row
      ? { source: row.source, scheduleJobId: row.scheduleJobId }
      : null;
  } catch {
    return null;
  }
}

function defaultGetScheduleName(id: string): string | null {
  try {
    return getSchedule(id)?.name ?? null;
  } catch {
    return null;
  }
}

/**
 * Return a copy of each feed item enriched with `sourceType`, `sourceKey`,
 * and `sourceLabel`. Conversation and schedule lookups are memoized across
 * the batch so each distinct source is resolved at most once.
 */
export function enrichFeedItemsWithSource(
  items: FeedItem[],
  deps: FeedSourceEnrichmentDeps = {},
): FeedItem[] {
  if (items.length === 0) return items;

  const getConversationRow =
    deps.getConversationRow ?? defaultGetConversationRow;
  const getScheduleName = deps.getScheduleName ?? defaultGetScheduleName;

  const convCache = new Map<string, ConversationSourceRow | null>();
  const resolveConv = (id: string): ConversationSourceRow | null => {
    if (!convCache.has(id)) convCache.set(id, getConversationRow(id));
    return convCache.get(id) ?? null;
  };

  const scheduleNameCache = new Map<string, string | null>();
  const resolveScheduleName = (id: string): string | null => {
    if (!scheduleNameCache.has(id)) {
      scheduleNameCache.set(id, getScheduleName(id));
    }
    return scheduleNameCache.get(id) ?? null;
  };

  return items.map((item) => {
    const row = item.conversationId ? resolveConv(item.conversationId) : null;
    const sourceType = classifyConversationSource(row?.source);

    const metadataScheduleId =
      typeof item.metadata?.scheduleId === "string"
        ? item.metadata.scheduleId
        : undefined;
    const scheduleId = metadataScheduleId ?? row?.scheduleJobId ?? undefined;

    let sourceKey: string;
    let sourceLabel: string;
    if (sourceType === "schedule" && scheduleId) {
      sourceKey = `schedule:${scheduleId}`;
      sourceLabel = resolveScheduleName(scheduleId) ?? "Scheduled";
    } else if (sourceType === "schedule") {
      sourceKey = "schedule";
      sourceLabel = "Scheduled";
    } else {
      sourceKey = sourceType;
      sourceLabel = STATIC_SOURCE_LABELS[sourceType];
    }

    // Surface the scheduleId in metadata when it was recovered from the
    // source conversation so clients have a single place to read it.
    const metadata =
      scheduleId !== undefined && metadataScheduleId === undefined
        ? { ...(item.metadata ?? {}), scheduleId }
        : item.metadata;

    return {
      ...item,
      sourceType,
      sourceKey,
      sourceLabel,
      ...(metadata ? { metadata } : {}),
    };
  });
}
