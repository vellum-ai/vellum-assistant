/**
 * The Old chats page's narrowing: which chip is selected, how that chip
 * reads off the URL, and which rows it leaves.
 *
 * Pure, so the page renders what these return and a test asserts the same
 * thing without a router or a query client.
 */

import { isExternalChannelOrigin } from "@/domains/chat/utils/conversation-channel";
import type {
  Conversation,
  ConversationGroup,
} from "@/types/conversation-types";
import {
  isBackgroundConversation,
  isCustomGroupId,
} from "@/utils/conversation-predicates";
import {
  OLD_CHATS_CHANNEL_PARAM,
  OLD_CHATS_FILTER_PARAM,
  OLD_CHATS_GROUP_PARAM,
} from "@/utils/routes";

/**
 * One chip's worth of narrowing. Single-select: a chip names the view, and
 * every view but `background` hides the automated rows, which is the whole
 * reason this page is readable at all.
 */
export type OldChatsFilter =
  | { kind: "all" }
  | { kind: "done" }
  | { kind: "background" }
  | { kind: "channel"; channelId: string }
  | { kind: "group"; groupId: string };

export const ALL_CHATS_FILTER: OldChatsFilter = { kind: "all" };

/** Identity for a chip's React key and its `selected` comparison. */
export function oldChatsFilterKey(filter: OldChatsFilter): string {
  switch (filter.kind) {
    case "channel":
      return `channel:${filter.channelId}`;
    case "group":
      return `group:${filter.groupId}`;
    default:
      return filter.kind;
  }
}

/**
 * The chip a link preselected, or All when the URL names none.
 *
 * Validated against what exists, never against the rows loaded so far: the
 * page holds a window onto the history, so a group whose chats are all older
 * than the first page is a perfectly good link. `groupIds` is the groups
 * query's own list, which is authoritative, so only a deleted group falls
 * back to All. A channel is taken at its word, since `origin_channel` is an
 * open set (a plugin channel's id is its plugin name) and there is no list to
 * check it against; the native origin is the exception, because chats started
 * in Vellum are what All already shows.
 */
export function filterFromSearchParams(
  params: URLSearchParams,
  available: { groupIds: readonly string[] },
): OldChatsFilter {
  const channelId = params.get(OLD_CHATS_CHANNEL_PARAM);
  if (channelId && isExternalChannelOrigin(channelId)) {
    return { kind: "channel", channelId };
  }
  const groupId = params.get(OLD_CHATS_GROUP_PARAM);
  if (groupId && available.groupIds.includes(groupId)) {
    return { kind: "group", groupId };
  }
  const named = params.get(OLD_CHATS_FILTER_PARAM);
  if (named === "done") {
    return { kind: "done" };
  }
  if (named === "background") {
    return { kind: "background" };
  }
  return ALL_CHATS_FILTER;
}

/**
 * The search string that preselects `filter`, with its leading `?`, or an
 * empty string for the default view. The one producer of these links: the
 * page's own chip row rewrites the URL through it, and anything linking into
 * a preselected view (a sidebar section header) builds its href from
 * `routes.oldChats` plus this.
 */
export function oldChatsSearchFor(filter: OldChatsFilter): string {
  const params = new URLSearchParams();
  switch (filter.kind) {
    case "channel":
      params.set(OLD_CHATS_CHANNEL_PARAM, filter.channelId);
      break;
    case "group":
      params.set(OLD_CHATS_GROUP_PARAM, filter.groupId);
      break;
    case "done":
    case "background":
      params.set(OLD_CHATS_FILTER_PARAM, filter.kind);
      break;
    case "all":
      break;
  }
  const search = params.toString();
  return search ? `?${search}` : "";
}

/** Whether a row is filed as done (the archive, under its user-facing name). */
export function isDoneConversation(conversation: Conversation): boolean {
  return conversation.archivedAt != null;
}

function matchesFilter(
  conversation: Conversation,
  filter: OldChatsFilter,
): boolean {
  switch (filter.kind) {
    case "all":
      return true;
    case "done":
      return isDoneConversation(conversation);
    case "background":
      return true;
    case "channel":
      return conversation.originChannel === filter.channelId;
    case "group":
      return conversation.groupId === filter.groupId;
  }
}

/**
 * The rows a chip leaves. Automated threads (background runs, scheduled jobs,
 * the heartbeat) are held back from every view but Background: they are the
 * noise this page exists to keep out of the way, and a thread explicitly
 * surfaced into Recents is not one of them ({@link isBackgroundConversation}
 * already makes that distinction).
 */
export function filterOldChats(
  conversations: readonly Conversation[],
  filter: OldChatsFilter,
): Conversation[] {
  const wantsBackground = filter.kind === "background";
  return conversations.filter((conversation) => {
    if (isBackgroundConversation(conversation) !== wantsBackground) {
      return false;
    }
    return matchesFilter(conversation, filter);
  });
}

/**
 * Case-insensitive title match over the rows already loaded, against both the
 * persisted title and the label an untitled row renders as.
 */
export function searchOldChats(
  conversations: readonly Conversation[],
  searchText: string,
  displayTitle: (title: string | null | undefined) => string,
): Conversation[] {
  const query = searchText.trim().toLowerCase();
  if (!query) {
    return conversations as Conversation[];
  }
  return conversations.filter((conversation) => {
    const persisted = (conversation.title ?? "").toLowerCase();
    return (
      persisted.includes(query) ||
      displayTitle(conversation.title).toLowerCase().includes(query)
    );
  });
}

/**
 * The chips to offer, in the order they are drawn: All, Done, one per channel
 * the loaded rows carry, one per custom group they belong to, then Background.
 *
 * Derived from the rows rather than from the channel and group registries, so
 * a chip never advertises a view that would come back empty. Only external
 * origins earn a chip: a native thread is what All already shows, and a chip
 * for it would read as a second All. Automated rows contribute none, since
 * every chip but Background hides them. Groups keep the order the groups query
 * returned, which is the order the sidebar draws them.
 *
 * `selected` is added when the loaded rows do not justify it, so a link into a
 * view whose chats are all older than the loaded window still shows the chip
 * it selected rather than a row of chips with none of them pressed.
 */
export function oldChatsFilters(
  conversations: readonly Conversation[],
  groups: readonly ConversationGroup[],
  selected: OldChatsFilter = ALL_CHATS_FILTER,
): OldChatsFilter[] {
  const channelIds = new Set<string>();
  const groupIds = new Set<string>();
  if (selected.kind === "channel") {
    channelIds.add(selected.channelId);
  }
  if (selected.kind === "group") {
    groupIds.add(selected.groupId);
  }
  for (const conversation of conversations) {
    if (isBackgroundConversation(conversation)) {
      continue;
    }
    if (isExternalChannelOrigin(conversation.originChannel)) {
      channelIds.add(conversation.originChannel!);
    }
    if (isCustomGroupId(conversation.groupId)) {
      groupIds.add(conversation.groupId);
    }
  }
  return [
    ALL_CHATS_FILTER,
    { kind: "done" },
    ...[...channelIds]
      .sort()
      .map((channelId): OldChatsFilter => ({ kind: "channel", channelId })),
    ...groups
      .filter((group) => groupIds.has(group.id))
      .map((group): OldChatsFilter => ({ kind: "group", groupId: group.id })),
    { kind: "background" },
  ];
}
