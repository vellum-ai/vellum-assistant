/**
 * Fetch wrappers for user-created schedule CRUD (create, update, toggle,
 * cancel, delete, runs, usage summary). System-task queries (heartbeat,
 * consolidation, retrospective) use generated SDK options directly, see
 * use-system-tasks.ts.
 *
 * Reading the schedule list is not here: `@/utils/schedules` owns it, because
 * its consumers span domains (settings, schedules, home, intelligence) and a
 * domain may not import a peer's internals.
 */
import {
  schedulesByIdCancelPost,
  schedulesByIdDelete,
  schedulesByIdPatch,
  schedulesByIdRunPost,
  schedulesByIdRunsGet,
  schedulesByIdTogglePost,
  schedulesReassignprofilePost,
  schedulesUsagesummaryGet,
  schedulesPost,
} from "@/generated/daemon/sdk.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";

import type {
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
  /**
   * Inference profile the schedule runs on. Every schedule carries a concrete
   * pin, so sending `null` does not unpin it: the daemon re-snapshots the
   * currently resolved default. Send a profile key to move the schedule.
   */
  inferenceProfile?: string | null;
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

const REASSIGN_PROFILE_ERROR =
  "Failed to move schedules to the selected profile.";

/**
 * Move schedules onto `toProfile`, returning how many actually moved.
 *
 * `fromProfile` narrows the move to the schedules pinned to that profile,
 * which is what the profile-delete flow needs so a deleted inference profile
 * never leaves schedules naming it. Passing `null` selects every schedule,
 * which is what re-pinning the whole set onto the current default needs:
 * schedules pinned under earlier defaults name several different profiles.
 * Schedules already on `toProfile` are skipped either way.
 */
export async function reassignScheduleInferenceProfile(
  assistantId: string,
  fromProfile: string | null,
  toProfile: string,
): Promise<number> {
  const { data, error, response } = await schedulesReassignprofilePost({
    path: { assistant_id: assistantId },
    body: {
      ...(fromProfile == null ? {} : { from: fromProfile }),
      to: toProfile,
    },
    throwOnError: false,
  });
  assertHasResponse(response, error, REASSIGN_PROFILE_ERROR);
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, REASSIGN_PROFILE_ERROR),
    );
  }
  return data?.reassigned ?? 0;
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

/**
 * Cancel a pending one-shot. The assistant marks it cancelled and it
 * leaves the upcoming list; it is not deleted.
 */
export async function cancelSchedule(
  assistantId: string,
  scheduleId: string,
): Promise<void> {
  const { error, response } = await schedulesByIdCancelPost({
    path: { assistant_id: assistantId, id: scheduleId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to cancel schedule.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to cancel schedule."),
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
