import type { QueryClient } from "@tanstack/react-query";

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
