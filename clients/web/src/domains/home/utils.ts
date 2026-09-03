import {
  type FeedItem,
  type FeedItemStatus,
  isPendingGuardianFeedItem,
} from "@vellumai/assistant-api";

import { flattenSummary } from "./feed-preview";

/**
 * Sort feed items: pending guardian items first (they block the
 * assistant on the user, so they head any list), then by priority
 * descending, then by createdAt descending.
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
 * The items the notifications bell shows: dismissed items are hidden, and so
 * are high-urgency ones, which surface through their own channels instead.
 *
 * A pending guardian item is the exception to the urgency rule: the bell is
 * that item's canonical home (no separate channel renders it), so it stays
 * visible however loud it is. The bell's unread dot, its list, and its bulk
 * actions all read this one derivation, so they cannot disagree.
 */
export function getVisibleFeedItems(items: FeedItem[]): FeedItem[] {
  return items.filter(
    (item) =>
      item.status !== "dismissed" &&
      (isPendingGuardianFeedItem(item) ||
        (item.urgency !== "high" && item.urgency !== "critical")),
  );
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
 * schedule. Returns null for feed items not tied to a schedule.
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
 * rather than showing syntax. Shared by the notification rows and the bell's
 * detail, so the title the user clicked is the title they land on.
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

/** Catalog keys naming a guardian request. */
export type GuardianLabelKey =
  | "category.guardianAction"
  | "category.guardianQuestion"
  | "category.guardianRequest";

/**
 * What to call a guardian-request item, on the row and on the panel it
 * opens. A waiting approval asks for something ("Guardian action
 * needed"); once it is settled nothing is needed of anyone, so it is
 * named for what it was. A question is a question either way. Null for
 * every other item, which is named by its own title.
 */
export function guardianLabelKey(item: FeedItem): GuardianLabelKey | null {
  if (!item.guardianRequest) {
    return null;
  }
  if (item.guardianRequest.intent === "question") {
    return "category.guardianQuestion";
  }
  return isPendingGuardianFeedItem(item)
    ? "category.guardianAction"
    : "category.guardianRequest";
}
