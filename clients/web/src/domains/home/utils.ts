import type {
  FeedItem,
  FeedItemCategory,
  FeedItemSourceType,
} from "@vellumai/assistant-api";

/**
 * Client-side grouping of feed items by recency. Not part of the wire
 * contract — derived in the UI from each item's `createdAt`.
 */
export type FeedTimeGroup = "today" | "yesterday" | "older";

/**
 * Sort feed items by priority descending, then by createdAt descending.
 */
export function sortFeedItems(items: FeedItem[]): FeedItem[] {
  return [...items].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

/**
 * Bucket items into "today", "yesterday", or "older" based on createdAt
 * in the local timezone. Returns a Map preserving order. Empty groups
 * are omitted.
 */
export function groupByTime(items: FeedItem[]): Map<FeedTimeGroup, FeedItem[]> {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - 1,
  );

  const groups: Record<FeedTimeGroup, FeedItem[]> = {
    today: [],
    yesterday: [],
    older: [],
  };

  for (const item of items) {
    const created = new Date(item.createdAt);
    if (created >= todayStart) {
      groups.today.push(item);
    } else if (created >= yesterdayStart) {
      groups.yesterday.push(item);
    } else {
      groups.older.push(item);
    }
  }

  const result = new Map<FeedTimeGroup, FeedItem[]>();
  if (groups.today.length > 0) result.set("today", groups.today);
  if (groups.yesterday.length > 0) result.set("yesterday", groups.yesterday);
  if (groups.older.length > 0) result.set("older", groups.older);

  return result;
}

/**
 * Filter items by category. If category is null, return all items.
 */
export function filterByCategory(
  items: FeedItem[],
  category: FeedItemCategory | null,
): FeedItem[] {
  if (category === null) return items;
  return items.filter((item) => (item.category ?? "system") === category);
}

/**
 * Exclude items with urgency "high" or "critical".
 */
export function excludeHighUrgency(items: FeedItem[]): FeedItem[] {
  return items.filter(
    (item) => item.urgency !== "high" && item.urgency !== "critical",
  );
}

/**
 * Return deduplicated list of categories present in the items.
 */
export function getPresentCategories(items: FeedItem[]): FeedItemCategory[] {
  const categories = new Set<FeedItemCategory>();
  for (const item of items) {
    categories.add(item.category ?? "system");
  }
  return [...categories];
}

/**
 * A distinct producer of feed items, identified by `key`. Schedules each
 * get their own key (`schedule:<id>`); other producers (heartbeat, memory
 * consolidation, …) share a key per `type`. Used to build the source filter.
 */
export interface FeedSource {
  key: string;
  label: string;
  type: FeedItemSourceType;
}

// Display order for the source filter: producer types first in a fixed
// order, schedules grouped together and sorted by name within that band.
const SOURCE_TYPE_ORDER: Record<FeedItemSourceType, number> = {
  heartbeat: 0,
  memory_consolidation: 1,
  schedule: 2,
  auto_analysis: 3,
  user: 4,
  other: 5,
};

/**
 * Return the distinct sources present in the items, ordered for display.
 * Items missing a `sourceKey` (e.g. not yet enriched) are skipped — they
 * remain visible under the "All sources" option.
 */
export function getPresentSources(items: FeedItem[]): FeedSource[] {
  const byKey = new Map<string, FeedSource>();
  for (const item of items) {
    const key = item.sourceKey;
    if (!key || byKey.has(key)) continue;
    byKey.set(key, {
      key,
      label: item.sourceLabel ?? key,
      type: item.sourceType ?? "other",
    });
  }
  return [...byKey.values()].sort((a, b) => {
    const rankDiff = SOURCE_TYPE_ORDER[a.type] - SOURCE_TYPE_ORDER[b.type];
    return rankDiff !== 0 ? rankDiff : a.label.localeCompare(b.label);
  });
}

/**
 * Filter items by source key. If sourceKey is null, return all items.
 */
export function filterBySource(
  items: FeedItem[],
  sourceKey: string | null,
): FeedItem[] {
  if (sourceKey === null) return items;
  return items.filter((item) => item.sourceKey === sourceKey);
}
