import type {
  FeedItem,
  FeedItemCategory,
  FeedItemStatus,
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
 * The items the notification surfaces show: dismissed items are hidden and
 * high-urgency items surface through their own channels. Shared by the
 * Activity page and the notifications bell so the bell's unread dot and
 * bulk actions always agree with the page it links to.
 */
export function getVisibleFeedItems(items: FeedItem[]): FeedItem[] {
  return excludeHighUrgency(items.filter((i) => i.status !== "dismissed"));
}

/** Arguments for the feed's bulk status mutation (`markAll`). */
export interface FeedMarkAllArgs {
  from: FeedItemStatus[];
  to: FeedItemStatus;
  ids: string[];
}

/** Bulk payload marking every visible unread item as read. */
export function markAllReadArgs(visibleItems: FeedItem[]): FeedMarkAllArgs {
  return {
    from: ["new"],
    to: "seen",
    ids: visibleItems.filter((i) => i.status === "new").map((i) => i.id),
  };
}

/** Bulk payload dismissing every visible item ("Clear all"). */
export function clearAllArgs(visibleItems: FeedItem[]): FeedMarkAllArgs {
  return {
    from: ["new", "seen", "acted_on"],
    to: "dismissed",
    ids: visibleItems.map((i) => i.id),
  };
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

