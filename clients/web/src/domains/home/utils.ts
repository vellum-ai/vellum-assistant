import {
  type FeedItem,
  type FeedItemCategory,
  type FeedItemStatus,
  isPendingGuardianFeedItem,
} from "@vellumai/assistant-api";

import { flattenSummary } from "./feed-preview";

/**
 * Client-side grouping of feed items by recency. Not part of the wire
 * contract — derived in the UI from each item's `createdAt`.
 */
export type FeedTimeGroup = "today" | "yesterday" | "older";

/**
 * Sort feed items: pending guardian items first (they block the
 * assistant on the user, so they are the "Needs attention" head of any
 * list), then by priority descending, then by createdAt descending.
 */
export function sortFeedItems(items: FeedItem[]): FeedItem[] {
  return [...items].sort((a, b) => {
    const guardianDelta =
      Number(isPendingGuardianFeedItem(b)) -
      Number(isPendingGuardianFeedItem(a));
    if (guardianDelta !== 0) {
      return guardianDelta;
    }
    if (a.priority !== b.priority) {
      return b.priority - a.priority;
    }
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
  if (groups.today.length > 0) {
    result.set("today", groups.today);
  }
  if (groups.yesterday.length > 0) {
    result.set("yesterday", groups.yesterday);
  }
  if (groups.older.length > 0) {
    result.set("older", groups.older);
  }

  return result;
}

/**
 * Filter items by category. If category is null, return all items.
 */
export function filterByCategory(
  items: FeedItem[],
  category: FeedItemCategory | null,
): FeedItem[] {
  if (category === null) {
    return items;
  }
  return items.filter((item) => (item.category ?? "system") === category);
}

/**
 * Exclude items with urgency "high" or "critical", except a pending
 * guardian item: the notification surfaces are that item's canonical
 * home (there is no separate channel that renders it), so the
 * "surfaces through its own channels" rationale below does not apply
 * to it.
 */
export function excludeHighUrgency(items: FeedItem[]): FeedItem[] {
  return items.filter(
    (item) =>
      isPendingGuardianFeedItem(item) ||
      (item.urgency !== "high" && item.urgency !== "critical"),
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

/**
 * Read a non-empty string id out of a feed item's free-form `metadata` bag.
 *
 * `metadata` is `Record<string, unknown>` on the wire (the daemon spreads a
 * notification's whole context payload into it, see `home-feed-side-effect.ts`),
 * so every entity id a link is built from has to be narrowed the same way.
 */
function readMetadataId(item: FeedItem | null, key: string): string | null {
  const id = item?.metadata?.[key];
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Scheduled-run notifications (`schedule.notify`) carry their originating
 * schedule id in `metadata.scheduleId`, letting a detail view link to the
 * schedule. Returns null for feed items not tied to a schedule. Shared by the
 * Activity page and the notifications bell so both offer the link on exactly
 * the same items.
 */
export function getFeedItemScheduleId(item: FeedItem | null): string | null {
  return readMetadataId(item, "scheduleId");
}

/**
 * Background skill-update notifications carry the id of the skill the
 * retrospective rewrote in `metadata.skillId` (emitted by
 * `notifyBackgroundSkillUpdate` in the daemon's `scaffold-managed` tool),
 * letting a detail view link to the skill it names. Returns null for feed
 * items not tied to a skill.
 *
 * Only *updates* reach the feed. A newly authored skill announces itself with
 * an in-chat card instead (`skill-created-card.tsx`), which deep-links the same
 * way; this is the update path's equivalent.
 */
export function getFeedItemSkillId(item: FeedItem | null): string | null {
  return readMetadataId(item, "skillId");
}

/**
 * Name for an item with neither a title nor a summary that renders as text, so
 * the surface showing it always has something to name it by. The category is
 * not used here: on a card carrying its category chip, repeating it would read
 * the same word twice.
 */
const UNNAMED_ITEM_TITLE = "Notification";

/**
 * Display name for a feed item: its own title, or its summary when it carries
 * none. `summary` is markdown, so the fallback goes through the flattener
 * rather than showing syntax. Shared by the Activity page's rows and the
 * notifications bell so the title the user clicked is the title they land on.
 *
 * Flattening parses markdown, so callers rendering a list memoize the result on
 * the two fields it reads.
 */
export function resolveFeedItemTitle(
  item: Pick<FeedItem, "title" | "summary">,
): string {
  const resolved = item.title ?? flattenSummary(item.summary);
  return resolved.length > 0 ? resolved : UNNAMED_ITEM_TITLE;
}

/** Arguments for the feed's bulk status mutation (`markAll`). */
export interface FeedMarkAllArgs {
  from: FeedItemStatus[];
  to: FeedItemStatus;
  ids: string[];
}

/**
 * Bulk payload marking every visible unread item as read.
 *
 * Pending guardian items stay out of both bulk payloads: marking one
 * read is not a substitute for resolving it (the unread dot is its
 * "needs you" signal), and clearing one would hide the only canonical
 * home an unresolved request has. The daemon enforces the dismissal
 * half server-side; excluding them here keeps the optimistic cache
 * update honest.
 */
export function markAllReadArgs(visibleItems: FeedItem[]): FeedMarkAllArgs {
  return {
    from: ["new"],
    to: "seen",
    ids: visibleItems
      .filter((i) => i.status === "new" && !isPendingGuardianFeedItem(i))
      .map((i) => i.id),
  };
}

/** Bulk payload dismissing every visible item ("Clear all"). */
export function clearAllArgs(visibleItems: FeedItem[]): FeedMarkAllArgs {
  return {
    from: ["new", "seen", "acted_on"],
    to: "dismissed",
    ids: visibleItems
      .filter((i) => !isPendingGuardianFeedItem(i))
      .map((i) => i.id),
  };
}

/** Catalog keys a guardian row's category chip may carry. */
export type GuardianCategoryLabelKey =
  | "category.guardianAction"
  | "category.guardianQuestion";

/**
 * Category label override for a guardian-request item. The wire
 * `category` stays `security` (older clients keep their chip), but a
 * guardian row names what it actually needs: an action or an answer.
 * Null for every other item, which keeps its category's own label.
 */
export function guardianCategoryLabelKey(
  item: FeedItem,
): GuardianCategoryLabelKey | null {
  if (!item.guardianRequest) {
    return null;
  }
  return item.guardianRequest.intent === "question"
    ? "category.guardianQuestion"
    : "category.guardianAction";
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
