import type { QueryClient } from "@tanstack/react-query";

export const AVATAR_QUERY_KEY_PREFIX = "assistantAvatar";

export function avatarQueryKey(assistantId: string) {
  return [AVATAR_QUERY_KEY_PREFIX, assistantId] as const;
}

export const CONVERSATIONS_QUERY_KEY = "conversations" as const;

export function conversationsQueryKey(assistantId: string | null) {
  return [CONVERSATIONS_QUERY_KEY, assistantId ?? ""] as const;
}

export function assistantDaemonConfigQueryKey(
  assistantId: string | null | undefined,
) {
  return ["daemon-config", assistantId] as const;
}

export function assistantSoundsConfigQueryKey(
  assistantId: string | null | undefined,
) {
  return ["soundsConfig", assistantId] as const;
}

export function assistantSoundsAvailableQueryKey(
  assistantId: string | null | undefined,
) {
  return ["soundsAvailable", assistantId] as const;
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

export const HOME_FEED_QUERY_KEY_PREFIX = "home-feed" as const;

export function homeFeedQueryKey(assistantId: string) {
  return [HOME_FEED_QUERY_KEY_PREFIX, assistantId] as const;
}

export const HOME_STATE_QUERY_KEY_PREFIX = "home-state" as const;

export function homeStateQueryKey(assistantId: string) {
  return [HOME_STATE_QUERY_KEY_PREFIX, assistantId] as const;
}

export function invalidateAssistantConfigQueries(
  queryClient: QueryClient,
  assistantId: string | null | undefined,
): void {
  if (!assistantId) return;
  void queryClient.invalidateQueries({
    queryKey: assistantDaemonConfigQueryKey(assistantId),
  });
}

export function invalidateAssistantSoundsQueries(
  queryClient: QueryClient,
  assistantId: string | null | undefined,
): void {
  if (!assistantId) return;
  void queryClient.invalidateQueries({
    queryKey: assistantSoundsConfigQueryKey(assistantId),
  });
  void queryClient.invalidateQueries({
    queryKey: assistantSoundsAvailableQueryKey(assistantId),
  });
}

export function invalidateAssistantSchedulesQueries(
  queryClient: QueryClient,
  assistantId: string | null | undefined,
): void {
  if (!assistantId) return;
  void queryClient.invalidateQueries({
    queryKey: assistantSchedulesQueryKey(assistantId),
  });
  void queryClient.invalidateQueries({
    queryKey: assistantScheduleRunsQueryKey(assistantId),
  });
}
