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

export const CONVERSATIONS_QUERY_KEY = "conversations" as const;

export function conversationsQueryKey(assistantId: string | null) {
  return [CONVERSATIONS_QUERY_KEY, assistantId ?? ""] as const;
}

export const ARCHIVED_CONVERSATIONS_QUERY_KEY =
  "archived-conversations" as const;

export function archivedConversationsQueryKey(assistantId: string | null) {
  return [ARCHIVED_CONVERSATIONS_QUERY_KEY, assistantId ?? ""] as const;
}

export const BACKGROUND_CONVERSATIONS_QUERY_KEY =
  "background-conversations" as const;

export function backgroundConversationsQueryKey(assistantId: string | null) {
  return [BACKGROUND_CONVERSATIONS_QUERY_KEY, assistantId ?? ""] as const;
}

export const SCHEDULED_CONVERSATIONS_QUERY_KEY =
  "scheduled-conversations" as const;

export function scheduledConversationsQueryKey(assistantId: string | null) {
  return [SCHEDULED_CONVERSATIONS_QUERY_KEY, assistantId ?? ""] as const;
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
