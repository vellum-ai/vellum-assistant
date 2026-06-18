import type { Conversation, ConversationGroup } from "@/types/conversation-types";
import { isScheduledConversation } from "@/utils/conversation-predicates";
/**
 * Pure helper for splitting the sidebar's conversation list into system
 * category buckets (`pinned`, `slack`, `scheduled`, `background`, `recents`) and
 * optional user-defined custom groups.
 *
 * Categorization (mirrors backend conventions in `web/src/lib/chat/api.ts`):
 *
 * - `pinned` — `isPinned === true`. Takes priority over every other bucket.
 * - `slack` — Slack-origin conversations with no explicit group assignment
 *   (or legacy `groupId === "system:all"`). Slack is a first-class origin
 *   section, not a foreground/background status.
 * - `scheduled` — `conversationType === "scheduled"` OR legacy
 *   `groupId === "system:scheduled"`.
 * - `background` — all background threads
 *   (`conversationType === "background"` or `groupId === "system:background"`),
 *   including auto-analysis (reflections). Sub-grouping by `source` is
 *   handled downstream by `backgroundSubGroups.ts`.
 * - `recents` — everything else (foreground, non-pinned), sorted by
 *   `lastMessageAt` descending. Background/scheduled conversations with a
 *   non-null `surfacedAt` (explicitly promoted via the daemon's surface API)
 *   land here instead of their system buckets.
 *
 * Archived conversations (`archivedAt != null`) are excluded from every
 * bucket.
 *
 * Kept deliberately in its own file (no React, no icons) so it can be unit
 * tested without a DOM and reused by other surfaces if a compact recent-list
 * ever appears elsewhere in the app.
 */

export interface CustomGroup {
  id: string;
  name: string;
  conversations: Conversation[];
}

export interface GroupedConversations {
  pinned: Conversation[];
  scheduled: Conversation[];
  background: Conversation[];
  slack: Conversation[];
  recents: Conversation[];
  customGroups: CustomGroup[];
}

/**
 * True when a conversation is pinned, via either the modern `isPinned`
 * boolean or the legacy `groupId === "system:pinned"` marker. Some
 * conversations (especially older ones) only carry the legacy marker,
 * so checking `isPinned` alone misses them and shows the wrong
 * Pin/Unpin label in the actions menu.
 */
export function isConversationPinned(c: Conversation): boolean {
  return c.isPinned === true || c.groupId === "system:pinned";
}

function isBackground(c: Conversation): boolean {
  return (
    c.conversationType === "background" || c.groupId === "system:background"
  );
}

export function isSlackConversation(c: Conversation): boolean {
  return c.originChannel === "slack";
}

function shouldBucketInSlackSection(c: Conversation): boolean {
  return (
    isSlackConversation(c) &&
    (c.groupId == null || c.groupId === "system:all")
  );
}

/**
 * Read the `lastMessageAt` epoch-ms timestamp for numeric comparison.
 * Missing values fall back to `0` so the caller's sort is stable.
 */
function parseLastMessageAt(conversation: Conversation): number {
  return conversation.lastMessageAt ?? 0;
}

/**
 * Stable fallback order for pinned / custom-group rows that have no
 * server-assigned `displayOrder`, and the tie-breaker when two rows share a
 * `displayOrder`.
 *
 * Keyed on the immutable `createdAt` (newest-created first) — deliberately NOT
 * `lastMessageAt`. Pinning sends no `displayOrder` (the daemon stores it as
 * NULL until the user drag-reorders), so without this every pinned row would
 * sort by recency and jump to the top whenever a new message landed in it.
 * Pinned rows should hold their position regardless of activity, so we sort by
 * creation time, which never changes. `conversationId` is the final
 * tie-breaker so the order stays fully deterministic when `createdAt` is equal
 * or missing.
 */
function compareByCreatedAt(a: Conversation, b: Conversation): number {
  const byCreated = (b.createdAt ?? 0) - (a.createdAt ?? 0);
  if (byCreated !== 0) return byCreated;
  return a.conversationId.localeCompare(b.conversationId);
}

/**
 * Comparator for buckets where the user can manually drag-reorder rows
 * (pinned, custom groups). Conversations with a server-provided
 * `displayOrder` come first in ascending order; ties and rows without
 * `displayOrder` fall back to a stable creation-time order so pinned rows
 * never reshuffle when activity arrives (see {@link compareByCreatedAt}).
 */
function compareByDisplayOrder(a: Conversation, b: Conversation): number {
  const aOrder = a.displayOrder;
  const bOrder = b.displayOrder;
  if (aOrder != null && bOrder != null) {
    if (aOrder !== bOrder) return aOrder - bOrder;
    return compareByCreatedAt(a, b);
  }
  if (aOrder != null) return -1;
  if (bOrder != null) return 1;
  return compareByCreatedAt(a, b);
}

/**
 * True when a `groupId` refers to a non-system (custom) group.
 * System groups use a `"system:"` prefix (e.g. `"system:pinned"`).
 */
function isCustomGroupId(groupId: string | undefined): groupId is string {
  return !!groupId && !groupId.startsWith("system:");
}

export function groupConversations(
  conversations: Conversation[],
  options?: {
    groups?: ConversationGroup[];
  },
): GroupedConversations {
  const pinned: Conversation[] = [];
  const scheduled: Conversation[] = [];
  const background: Conversation[] = [];
  const slack: Conversation[] = [];
  const recents: Conversation[] = [];

  // Build a lookup from group id → CustomGroup bucket.
  const groupLookup = new Map<string, CustomGroup>();
  const customGroupsList: CustomGroup[] = [];
  if (options?.groups) {
    for (const g of options.groups) {
      if (g.isSystemGroup) continue;
      const bucket: CustomGroup = { id: g.id, name: g.name, conversations: [] };
      groupLookup.set(g.id, bucket);
      customGroupsList.push(bucket);
    }
  }

  for (const c of conversations) {
    // Skip archived — they live in a separate view, not the sidebar.
    if (c.archivedAt != null) continue;

    // Pinned wins over every other classification.
    if (isConversationPinned(c)) {
      pinned.push(c);
      continue;
    }

    // Explicit custom group assignment wins over system-type routing —
    // a scheduled conversation moved to a custom group should stay
    // there because the server-provided groupId takes precedence over
    // deriveGroupId() heuristics.
    if (isCustomGroupId(c.groupId)) {
      const bucket = groupLookup.get(c.groupId);
      if (bucket) {
        bucket.conversations.push(c);
        continue;
      }
    }

    if (shouldBucketInSlackSection(c)) {
      slack.push(c);
      continue;
    }

    // Explicitly surfaced conversations are promoted into Recents instead
    // of the Scheduled/Background buckets (normal lastMessageAt sort).
    // Pinned, custom-group, and Slack precedence above stays as-is.
    if (c.surfacedAt != null) {
      recents.push(c);
      continue;
    }

    if (isScheduledConversation(c)) {
      scheduled.push(c);
      continue;
    }

    if (isBackground(c)) {
      background.push(c);
      continue;
    }

    recents.push(c);
  }

  // Copy before sort so we never mutate the caller's array. Sorting in-place
  // on a shared reference is a subtle source of downstream re-render churn
  // in React.
  const sortedRecents = recents.slice().sort((a, b) => {
    return parseLastMessageAt(b) - parseLastMessageAt(a);
  });
  const sortedSlack = slack.slice().sort((a, b) => {
    return parseLastMessageAt(b) - parseLastMessageAt(a);
  });
  // Pinned + custom groups honor `displayOrder` (set when the user
  // drag-reorders). Any global resort by recency at this level would
  // override the user's custom order — see LUM-1619.
  const sortedPinned = pinned.slice().sort(compareByDisplayOrder);
  for (const bucket of customGroupsList) {
    bucket.conversations.sort(compareByDisplayOrder);
  }

  return {
    pinned: sortedPinned,
    scheduled,
    background,
    slack: sortedSlack,
    recents: sortedRecents,
    customGroups: customGroupsList,
  };
}
