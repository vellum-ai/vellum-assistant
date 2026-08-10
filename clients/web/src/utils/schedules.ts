import { schedulesGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { schedulesGet } from "@/generated/daemon/sdk.gen";
import type { SchedulesGetResponse } from "@/generated/daemon/types.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";

export type AssistantSchedule = SchedulesGetResponse["schedules"][number];

function normalizeSchedule(schedule: AssistantSchedule): AssistantSchedule {
  const raw = schedule as AssistantSchedule & {
    cadenceDescription?: string;
    description?: string;
  };
  const description = raw.description ?? "";
  return {
    ...schedule,
    description,
    cadenceDescription: raw.cadenceDescription ?? description,
  };
}

export async function fetchSchedules(
  assistantId: string,
): Promise<AssistantSchedule[]> {
  const { data, error, response } = await schedulesGet({
    path: { assistant_id: assistantId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load schedules.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to load schedules."),
    );
  }
  return (data?.schedules ?? []).map(normalizeSchedule);
}

/**
 * TanStack Query options for the schedules list. The single definition of the
 * list's query key + staleTime, so every consumer (the Schedules page data
 * hook, the Activity feed's "View schedule" link validation) reads one shared
 * cache entry instead of hand-copying the key.
 *
 * Lives here rather than in `domains/settings/api/schedules.ts` because
 * consumers span domains (settings, schedules, home) and a domain may not
 * import a peer's internals. The settings module re-exports it for its own
 * callers.
 */
export function schedulesListQueryOptions(assistantId: string | undefined) {
  return {
    queryKey: schedulesGetQueryKey({
      path: { assistant_id: assistantId ?? "" },
    }),
    queryFn: () =>
      assistantId
        ? fetchSchedules(assistantId)
        : Promise.resolve<AssistantSchedule[]>([]),
    staleTime: 10_000,
  };
}
