/**
 * Fetch wrappers for user-created schedule CRUD (list, create, update, toggle,
 * delete, runs, usage summary). System-task queries (heartbeat, consolidation,
 * retrospective) use generated SDK options directly — see use-system-tasks.ts.
 */
import {
  schedulesByIdDelete,
  schedulesByIdPatch,
  schedulesByIdRunPost,
  schedulesByIdRunsGet,
  schedulesByIdTogglePost,
  schedulesUsagesummaryGet,
  schedulesPost,
} from "@/generated/daemon/sdk.gen";
import { schedulesGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";
import { fetchSchedules as fetchSharedSchedules } from "@/utils/schedules";

import type {
  Schedule,
  ScheduleRun,
  ScheduleUsageSummary,
} from "@/domains/settings/types/schedules";

export { ApiError };

/** One page of run history plus the cursor for fetching older runs. */
export interface ScheduleRunsPage {
  runs: ScheduleRun[];
  /** Pass back as `before` to fetch older runs; null when history is exhausted. */
  nextCursor: number | null;
}

/** Page size used by the run-history detail views. */
export const SCHEDULE_RUNS_PAGE_SIZE = 25;

export interface CreateSchedulePayload {
  name: string;
  description: string;
  expression: string;
  message: string;
  timezone?: string | null;
  enabled?: boolean;
}

export async function createSchedule(
  assistantId: string,
  payload: CreateSchedulePayload,
): Promise<void> {
  const { error, response } = await schedulesPost({
    path: { assistant_id: assistantId },
    body: payload,
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to create schedule.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to create schedule."),
    );
  }
}

export interface UpdateSchedulePayload {
  timeoutMs?: number | null;
}

export async function updateSchedule(
  assistantId: string,
  scheduleId: string,
  payload: UpdateSchedulePayload,
): Promise<void> {
  const { error, response } = await schedulesByIdPatch({
    path: { assistant_id: assistantId, id: scheduleId },
    body: payload,
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to update schedule.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to update schedule."),
    );
  }
}

export async function fetchSchedules(assistantId: string): Promise<Schedule[]> {
  return fetchSharedSchedules(assistantId);
}

/**
 * TanStack Query options for the schedules list. The single definition of
 * the list's query key + staleTime, so every consumer (the Schedules page
 * data hook, the Activity page's "View schedule" link validation) reads one
 * shared cache entry instead of hand-copying the key.
 */
export function schedulesListQueryOptions(assistantId: string | undefined) {
  return {
    queryKey: schedulesGetQueryKey({ path: { assistant_id: assistantId ?? "" } }),
    queryFn: () =>
      assistantId ? fetchSchedules(assistantId) : Promise.resolve<Schedule[]>([]),
    staleTime: 10_000,
  };
}

export async function fetchScheduleRuns(
  assistantId: string,
  scheduleId: string,
  limit = 10,
  before?: number,
): Promise<ScheduleRunsPage> {
  const { data, error, response } = await schedulesByIdRunsGet({
    path: { assistant_id: assistantId, id: scheduleId },
    query: { limit, before },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load schedule runs.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to load schedule runs."),
    );
  }
  return { runs: data?.runs ?? [], nextCursor: data?.nextCursor ?? null };
}

export interface ScheduleUsageSummaryRange {
  from: number;
  to: number;
}

export async function fetchScheduleUsageSummary(
  assistantId: string,
  range: ScheduleUsageSummaryRange,
): Promise<ScheduleUsageSummary[]> {
  const { data, error, response } = await schedulesUsagesummaryGet({
    path: { assistant_id: assistantId },
    query: { from: range.from, to: range.to },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load schedule usage.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to load schedule usage."),
    );
  }
  return data?.summaries ?? [];
}

export async function toggleSchedule(
  assistantId: string,
  scheduleId: string,
  enabled: boolean,
): Promise<void> {
  const { error, response } = await schedulesByIdTogglePost({
    path: { assistant_id: assistantId, id: scheduleId },
    body: { enabled },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to toggle schedule.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to toggle schedule."),
    );
  }
}

export async function deleteSchedule(
  assistantId: string,
  scheduleId: string,
): Promise<void> {
  const { error, response } = await schedulesByIdDelete({
    path: { assistant_id: assistantId, id: scheduleId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to delete schedule.");
  if (!response.ok && response.status !== 204) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to delete schedule."),
    );
  }
}

export async function runScheduleNow(
  assistantId: string,
  scheduleId: string,
): Promise<void> {
  const { error, response } = await schedulesByIdRunPost({
    path: { assistant_id: assistantId, id: scheduleId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to run schedule.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to run schedule."),
    );
  }
}


