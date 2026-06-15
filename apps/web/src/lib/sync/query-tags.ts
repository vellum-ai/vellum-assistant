import {
  configGetQueryKey,
  groupsGetQueryKey,
  soundsAvailableGetQueryKey,
  soundsConfigGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { Options } from "@/generated/daemon/sdk.gen";
import type {
  ConfigGetData,
  GroupsGetData,
  SoundsAvailableGetData,
  SoundsConfigGetData,
} from "@/generated/daemon/types.gen";

export const AVATAR_QUERY_KEY_PREFIX = "assistantAvatar";

export function avatarQueryKey(assistantId: string) {
  return [AVATAR_QUERY_KEY_PREFIX, assistantId] as const;
}

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
 * assistant. Matches every `["conversation-list", id, "channel", *]` entry.
 */
export function originChannelListPrefix(assistantId: string | null) {
  return [CONVERSATION_LIST_PREFIX, assistantId ?? "", "channel"] as const;
}

export function originChannelConversationsQueryKey(
  assistantId: string | null,
  channel: string,
) {
  return [
    CONVERSATION_LIST_PREFIX,
    assistantId ?? "",
    "channel",
    channel,
  ] as const;
}

/**
 * Build the generated query key for conversation groups. Exported so that
 * invalidation call sites (sync stream, loader, group actions) can target
 * the same cache entry that `useConversationGroupsQuery` populates.
 */
export function conversationGroupsQueryKey(
  assistantId: string | null,
): ReturnType<typeof groupsGetQueryKey> {
  return groupsGetQueryKey({
    path: { assistant_id: assistantId ?? "" },
  } as Options<GroupsGetData>);
}

/**
 * Build the generated query key for the daemon config. All consumers —
 * sync handler, service cards, imperative invalidation — share one cache
 * entry via this key.
 */
export function assistantDaemonConfigQueryKey(
  assistantId: string | null | undefined,
): ReturnType<typeof configGetQueryKey> {
  return configGetQueryKey({
    path: { assistant_id: assistantId ?? "" },
  } as Options<ConfigGetData>);
}

export function assistantSoundsConfigQueryKey(
  assistantId: string | null | undefined,
): ReturnType<typeof soundsConfigGetQueryKey> {
  return soundsConfigGetQueryKey({
    path: { assistant_id: assistantId ?? "" },
  } as Options<SoundsConfigGetData>);
}

export function assistantSoundsAvailableQueryKey(
  assistantId: string | null | undefined,
): ReturnType<typeof soundsAvailableGetQueryKey> {
  return soundsAvailableGetQueryKey({
    path: { assistant_id: assistantId ?? "" },
  } as Options<SoundsAvailableGetData>);
}

export function assistantSchedulesQueryKey(
  assistantId: string | null | undefined,
) {
  return ["schedules", assistantId] as const;
}

export function assistantScheduleRunsQueryKey(
  assistantId: string | null | undefined,
  scheduleId?: string | null,
) {
  return scheduleId
    ? (["schedule-runs", assistantId, scheduleId] as const)
    : (["schedule-runs", assistantId] as const);
}

export function assistantScheduleUsageSummaryQueryKey(
  assistantId: string | null | undefined,
  tz?: string | null,
) {
  return tz
    ? (["schedule-usage-summary", assistantId, tz] as const)
    : (["schedule-usage-summary", assistantId] as const);
}

export const CLIENT_FLAG_QUERY_KEY = ["client-feature-flag-values"] as const;

export const ASSISTANT_FLAG_VALUES_QUERY_KEY =
  "assistant-feature-flag-values" as const;

export function assistantFlagValuesQueryKey(assistantId: string | null) {
  return [ASSISTANT_FLAG_VALUES_QUERY_KEY, assistantId] as const;
}

export const ASSISTANT_IDENTITY_QUERY_KEY = "assistant-identity" as const;

export function assistantIdentityQueryKey(assistantId: string | null) {
  return [ASSISTANT_IDENTITY_QUERY_KEY, assistantId ?? ""] as const;
}

export const ASSISTANT_IDENTITY_INTRO_QUERY_KEY = "identity-intro" as const;

export function assistantIdentityIntroQueryKey(
  assistantId: string | null | undefined,
) {
  return [ASSISTANT_IDENTITY_INTRO_QUERY_KEY, assistantId ?? ""] as const;
}
