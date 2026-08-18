import type {
  Conversation,
  ConversationGroup,
} from "@/types/conversation-types";
import { compareByRecency } from "@/utils/conversation-order";
import {
  isConversationPinned,
  isCustomGroupId,
  isScheduledConversation,
} from "@/utils/conversation-predicates";
import { isChannelConversation } from "@/domains/chat/utils/conversation-channel";
/**
 * Pure helper for splitting the sidebar's conversation list into system
 * category buckets (`pinned`, `channelSections`, `recents`) and optional
 * user-defined custom groups.
 *
 * These buckets are the derived fallback, not the sidebar's contents: each
 * section fetches its own rows (`useSectionConversations`) and falls back to
 * what is here while a section's query is gated off, pending, or failed.
 * Which sections exist is still read from these buckets.
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
 * - `recents` — everything else (foreground, non-pinned), sorted by
 *   `lastMessageAt` descending.
 *
 * Excluded from every bucket, because no section renders them:
 *
 * - archived conversations (`archivedAt != null`), which live in their own view
 * - scheduled threads (`conversationType === "scheduled"` or legacy
 *   `groupId === "system:scheduled"`)
 * - background threads (`conversationType === "background"` or legacy
 *   `groupId === "system:background"`), including auto-analysis reflections
 *
 * A scheduled or background conversation with a non-null `surfacedAt` has
 * been explicitly promoted through the daemon's surface API, and reaches
 * `recents` like any foreground thread.
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
  channelSections: ChannelSection[];
  recents: Conversation[];
  customGroups: CustomGroup[];
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

    /* Excluded rather than bucketed. Scheduled and background rows have no
       section of their own, so what matters is that they do not fall through
       into Chats. They reach the sidebar only by being surfaced, which the
       branch above already promoted. */
    if (isScheduledConversation(c) || isBackground(c)) {
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
  // `displayOrder` is not consulted anywhere: recency is the one order.
  const sortedPinned = pinned.slice().sort(compareByRecency);
  for (const bucket of customGroupsList) {
    bucket.conversations.sort(compareByRecency);
  }

  return {
    pinned: sortedPinned,
    channelSections,
    recents: sortedRecents,
    customGroups: customGroupsList,
  };
}
