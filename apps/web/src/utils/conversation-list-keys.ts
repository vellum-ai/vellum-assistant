import {
  groupsGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { Options } from "@/generated/daemon/sdk.gen";
import type { GroupsGetData } from "@/generated/daemon/types.gen";

// ---------------------------------------------------------------------------
// Conversation list query keys
//
// All conversation list caches share a common prefix:
//   ["conversation-list", assistantId, ...discriminator]
//
// This enables TanStack Query's prefix matching to operate on ALL
// conversation caches simultaneously (cancel, invalidate, snapshot, patch)
// without maintaining a static registry. Adding a new cache type (e.g., a
// new origin channel) automatically participates in cross-cache operations.
//
// References:
// - https://tanstack.com/query/latest/docs/framework/react/guides/query-keys#query-keys-are-hashed-deterministically
// - https://tanstack.com/query/latest/docs/framework/react/guides/filters#query-filters
// ---------------------------------------------------------------------------

export const CONVERSATION_LIST_PREFIX = "conversation-list" as const;

/**
 * Prefix key matching ALL conversation list caches for the given assistant.
 * Use with queryClient.cancelQueries / invalidateQueries / getQueriesData
 * to operate on every cache without knowing which buckets exist.
 */
export function conversationListPrefix(assistantId: string | null) {
  return [CONVERSATION_LIST_PREFIX, assistantId ?? ""] as const;
}

export function conversationsQueryKey(assistantId: string | null) {
  return [CONVERSATION_LIST_PREFIX, assistantId ?? "", "foreground"] as const;
}

export function archivedConversationsQueryKey(assistantId: string | null) {
  return [CONVERSATION_LIST_PREFIX, assistantId ?? "", "archived"] as const;
}

export function backgroundConversationsQueryKey(assistantId: string | null) {
  return [CONVERSATION_LIST_PREFIX, assistantId ?? "", "background"] as const;
}

export function scheduledConversationsQueryKey(assistantId: string | null) {
  return [CONVERSATION_LIST_PREFIX, assistantId ?? "", "scheduled"] as const;
}

/**
 * Prefix key matching all origin-channel conversation caches for the given
 * assistant. Matches every ["conversation-list", id, "channel", *] entry.
 */
export function originChannelListPrefix(assistantId: string | null) {
  return [CONVERSATION_LIST_PREFIX, assistantId ?? "", "channel"] as const;
}

/**
 * Build the generated query key for conversation groups. Exported so that
 * invalidation call sites (sync stream, loader, group actions) can target
 * the same cache entry that useConversationGroupsQuery populates.
 */
export function conversationGroupsQueryKey(
  assistantId: string | null,
): ReturnType<typeof groupsGetQueryKey> {
  return groupsGetQueryKey({
    path: { assistant_id: assistantId ?? "" },
  } as Options<GroupsGetData>);
}
