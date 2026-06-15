import {
  schedulesByIdRunsGetQueryKey,
  schedulesGetQueryKey,
  schedulesUsagesummaryGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { Options } from "@/generated/daemon/sdk.gen";
import type {
  SchedulesByIdRunsGetData,
  SchedulesGetData,
  SchedulesUsagesummaryGetData,
} from "@/generated/daemon/types.gen";

export function assistantSchedulesQueryKey(
  assistantId: string | null | undefined,
): ReturnType<typeof schedulesGetQueryKey> {
  return schedulesGetQueryKey({
    path: { assistant_id: assistantId ?? "" },
  } as Options<SchedulesGetData>);
}

export function assistantScheduleRunsQueryKey(
  assistantId: string | null | undefined,
  scheduleId?: string | null,
): ReturnType<typeof schedulesByIdRunsGetQueryKey> {
  return schedulesByIdRunsGetQueryKey({
    path: { assistant_id: assistantId ?? "", id: scheduleId ?? "" },
  } as Options<SchedulesByIdRunsGetData>);
}

export function assistantScheduleUsageSummaryQueryKey(
  assistantId: string | null | undefined,
  tz?: string | null,
): ReturnType<typeof schedulesUsagesummaryGetQueryKey> {
  return schedulesUsagesummaryGetQueryKey({
    path: { assistant_id: assistantId ?? "" },
    query: { tz: tz ?? undefined },
  } as unknown as Options<SchedulesUsagesummaryGetData>);
}
