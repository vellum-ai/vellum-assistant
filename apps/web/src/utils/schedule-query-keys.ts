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
