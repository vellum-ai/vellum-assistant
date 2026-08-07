import type {
  Conversation,
  ConversationGroup,
} from "@/types/conversation-types";
import { isScheduledConversation } from "@/utils/conversation-predicates";
import { isChannelConversation } from "@/domains/chat/utils/conversation-channel";
/**
 * Pure helper for splitting the sidebar's conversation list into system
 * category buckets (`pinned`, `channelSections`, `scheduled`, `background`,
 * `recents`) and optional user-defined custom groups.
 *
 * Categorization (mirrors backend conventions in `web/src/lib/chat/api.ts`):
 *
 * - `pinned` — `isPinned === true`. Takes priority over every other bucket.
 * - `channelSections` — conversations that originate from an external channel
 *   (Slack, Telegram, WhatsApp, phone, …) with no explicit group assignment
 *   (or legacy `groupId === "system:all"`). Each origin channel is a
 *   first-class collapsible section, not a foreground/background status; one
 *   `ChannelSection` is produced per channel that has conversations, ordered
 *   by channel id. With `groupByChannel: false` no channel sections are
 *   produced at all and those conversations go to `recents` instead, at the
 *   same point in the precedence chain, so which bucket a conversation is
 *   visible in changes but whether it is visible does not.
 * - `scheduled` — `conversationType === "scheduled"` OR legacy
 *   `groupId === "system:scheduled"`.
 * - `background` — all background threads
 *   (`conversationType === "background"` or `groupId === "system:background"`),
 *   including auto-analysis (reflections).
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
  /** Stored icon name from the group row; null when none was chosen
   *  (older assistants omit the field entirely). */
  icon: string | null;
  conversations: Conversation[];
}

/** One collapsible sidebar section for an external origin channel. */
export interface ChannelSection {
  /** Origin channel id, e.g. `"slack"`, `"telegram"`, `"whatsapp"`. */
  channelId: string;
  conversations: Conversation[];
}

export interface GroupedConversations {
  pinned: Conversation[];
  scheduled: Conversation[];
  background: Conversation[];
  channelSections: ChannelSection[];
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

/**
 * The origin channel id whose section this conversation belongs in, or
 * `null` when it isn't an unassigned external-channel conversation. Mirrors
 * the precedence the Slack section used: a channel conversation only buckets
 * into its section when it has no explicit (custom or system) group.
 */
function channelSectionBucketId(c: Conversation): string | null {
  if (!isChannelConversation(c)) {
    return null;
  }
  if (c.groupId != null && c.groupId !== "system:all") {
    return null;
  }
  return c.originChannel ?? null;
}

/**
 * Read the `lastMessageAt` epoch-ms timestamp for numeric comparison.
 * Missing values fall back to `0` so the caller's sort is stable.
 */
function parseLastMessageAt(conversation: Conversation): number {
  return conversation.lastMessageAt ?? 0;
}

/**
 * Recency order, newest first: the one order every section uses.
 *
 * No tiebreak. `Array.prototype.sort` is stable, so rows sharing a
 * `lastMessageAt` (or both missing one) keep the order they arrived in, which
 * is the server's. Adding an id tiebreak here would reorder them against it.
 */
function compareByRecency(a: Conversation, b: Conversation): number {
  return parseLastMessageAt(b) - parseLastMessageAt(a);
}

/**
 * True when a `groupId` refers to a non-system (custom) group.
 * System groups use a `"system:"` prefix (e.g. `"system:pinned"`).
 */
export function isCustomGroupId(
  groupId: string | undefined,
): groupId is string {
  return !!groupId && !groupId.startsWith("system:");
}

// ---------------------------------------------------------------------------
// Move-to-group helpers
// ---------------------------------------------------------------------------

/** A custom group a conversation can be filed into via the "Move to group" menu. */
export type MoveToGroupTarget = Pick<ConversationGroup, "id" | "name">;

/** True when a conversation currently belongs to a custom (non-system) group. */
export function isInCustomGroup(conversation: Conversation): boolean {
  return isCustomGroupId(conversation.groupId);
}

/**
 * Build the "Move to group" targets for a conversation: every custom
 * (non-system) group except the one it already belongs to.
 *
 * System buckets (Pinned, Recents, channel sections) are intentionally
 * excluded — Pinning has its own menu item, and the rest are derived sections,
 * not folders an arbitrary conversation can be filed into.
 */
export function buildMoveToGroupTargets(
  conversation: Conversation,
  groups?: ConversationGroup[],
): MoveToGroupTarget[] {
  const currentGroupId = conversation.groupId;
  return (groups ?? [])
    .filter((g) => !g.isSystemGroup && g.id !== currentGroupId)
    .map((g) => ({ id: g.id, name: g.name }));
}

export function groupConversations(
  conversations: Conversation[],
  options?: {
    groups?: ConversationGroup[];
    /**
     * Bucket unassigned external-channel conversations into one section per
     * origin channel. When `false`, `channelSections` comes back empty and
     * those conversations join `recents`, giving one flat recency list.
     * Defaults to `true`.
     */
    groupByChannel?: boolean;
  },
): GroupedConversations {
  const groupByChannel = options?.groupByChannel ?? true;
  const pinned: Conversation[] = [];
  const scheduled: Conversation[] = [];
  const background: Conversation[] = [];
  const channelBuckets = new Map<string, Conversation[]>();
  const recents: Conversation[] = [];

  // Build a lookup from group id → CustomGroup bucket.
  const groupLookup = new Map<string, CustomGroup>();
  const customGroupsList: CustomGroup[] = [];
  if (options?.groups) {
    for (const g of options.groups) {
      if (g.isSystemGroup) {
        continue;
      }
      const bucket: CustomGroup = {
        id: g.id,
        name: g.name,
        icon: g.icon ?? null,
        conversations: [],
      };
      groupLookup.set(g.id, bucket);
      customGroupsList.push(bucket);
    }
  }

  for (const c of conversations) {
    // Skip archived — they live in a separate view, not the sidebar.
    if (c.archivedAt != null) {
      continue;
    }

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

    // Channel precedence is the same in both modes; only the destination
    // differs. Short-circuiting here (rather than skipping the check when
    // channel sections are off) keeps membership identical between the two
    // views: a channel conversation that also carries a background or
    // scheduled type stays visible either way, instead of falling through to
    // a system bucket the sidebar never renders.
    const channelId = channelSectionBucketId(c);
    if (channelId) {
      if (!groupByChannel) {
        recents.push(c);
        continue;
      }
      const bucket = channelBuckets.get(channelId);
      if (bucket) {
        bucket.push(c);
      } else {
        channelBuckets.set(channelId, [c]);
      }
      continue;
    }

    // Explicitly surfaced conversations are promoted into Recents instead
    // of the Scheduled/Background buckets (normal lastMessageAt sort).
    // Pinned, custom-group, and channel-section precedence above stays as-is.
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
  const sortedRecents = recents.slice().sort(compareByRecency);
  // One section per channel that has conversations, each recency-sorted,
  // with the sections themselves ordered by channel id for a stable layout.
  const channelSections: ChannelSection[] = [...channelBuckets.entries()]
    .map(([channelId, convs]) => ({
      channelId,
      conversations: convs.slice().sort(compareByRecency),
    }))
    .sort((a, b) => a.channelId.localeCompare(b.channelId));
  // Pinned and the custom groups sort by recency like every other section.
  // They used to honor `displayOrder` instead, which only ever held a value
  // for someone who had drag-reordered (LUM-3108 removed that affordance).
  const sortedPinned = pinned.slice().sort(compareByRecency);
  for (const bucket of customGroupsList) {
    bucket.conversations.sort(compareByRecency);
  }

  return {
    pinned: sortedPinned,
    scheduled,
    background,
    channelSections,
    recents: sortedRecents,
    customGroups: customGroupsList,
  };
}
