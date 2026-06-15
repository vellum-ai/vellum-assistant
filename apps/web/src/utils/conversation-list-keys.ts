import {
  conversationsGetQueryKey,
  groupsGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { Options } from "@/generated/daemon/sdk.gen";
import type {
  ConversationsGetData,
  GroupsGetData,
} from "@/generated/daemon/types.gen";

// ---------------------------------------------------------------------------
// Conversation list query keys
//
// All conversation list caches use the generated `conversationsGetQueryKey`
// from the daemon SDK. TanStack Query's `partialMatchKey` recursively matches
// object subsets, so a key without `query` params acts as a wildcard prefix:
//
//   invalidateQueries({ queryKey: conversationsGetQueryKey({ path: { assistant_id } }) })
//
// matches ALL conversation caches (foreground, background, scheduled, archived,
// channel-scoped) for that assistant — no custom prefix scheme needed.
//
// References:
// - https://tanstack.com/query/latest/docs/framework/react/guides/query-keys
// - https://tanstack.com/query/latest/docs/framework/react/guides/filters
// ---------------------------------------------------------------------------

/**
 * Prefix key matching ALL conversation list caches for the given assistant.
 * Use with queryClient.cancelQueries / invalidateQueries / getQueriesData
 * to operate on every cache without knowing which buckets exist.
 */
export function conversationListPrefix(
  assistantId: string | null,
): ReturnType<typeof conversationsGetQueryKey> {
  return conversationsGetQueryKey({
    path: { assistant_id: assistantId ?? "" },
  } as Options<ConversationsGetData>);
}

export function conversationsQueryKey(
  assistantId: string | null,
): ReturnType<typeof conversationsGetQueryKey> {
  return conversationsGetQueryKey({
    path: { assistant_id: assistantId ?? "" },
  } as Options<ConversationsGetData>);
}

export function archivedConversationsQueryKey(
  assistantId: string | null,
): ReturnType<typeof conversationsGetQueryKey> {
  return conversationsGetQueryKey({
    path: { assistant_id: assistantId ?? "" },
    query: { archiveStatus: "archived" },
  } as Options<ConversationsGetData>);
}

export function backgroundConversationsQueryKey(
  assistantId: string | null,
): ReturnType<typeof conversationsGetQueryKey> {
  return conversationsGetQueryKey({
    path: { assistant_id: assistantId ?? "" },
    query: { conversationType: "background" },
  } as Options<ConversationsGetData>);
}

export function scheduledConversationsQueryKey(
  assistantId: string | null,
): ReturnType<typeof conversationsGetQueryKey> {
  return conversationsGetQueryKey({
    path: { assistant_id: assistantId ?? "" },
    query: { conversationType: "scheduled" },
  } as Options<ConversationsGetData>);
}

/**
 * Prefix key matching all origin-channel conversation caches for the given
 * assistant. With generated keys, this is identical to conversationListPrefix
 * — partial matching on just path matches all variants including channel-scoped.
 */
export function originChannelListPrefix(
  assistantId: string | null,
): ReturnType<typeof conversationsGetQueryKey> {
  return conversationsGetQueryKey({
    path: { assistant_id: assistantId ?? "" },
  } as Options<ConversationsGetData>);
}

/**
 * Build the query key for a specific origin-channel conversation list.
 */
export function originChannelQueryKey(
  assistantId: string | null,
  channel: string,
): ReturnType<typeof conversationsGetQueryKey> {
  return conversationsGetQueryKey({
    path: { assistant_id: assistantId ?? "" },
    query: { originChannel: channel },
  } as unknown as Options<ConversationsGetData>);
}

/**
 * Build the generated query key for conversation groups.
 */
export function conversationGroupsQueryKey(
  assistantId: string | null,
): ReturnType<typeof groupsGetQueryKey> {
  return groupsGetQueryKey({
    path: { assistant_id: assistantId ?? "" },
  } as Options<GroupsGetData>);
}
