/**
 * Hand-written fetch wrappers for the assistant daemon's schedule endpoints.
 * These endpoints are served via RuntimeProxyView under
 * /v1/assistants/{id}/schedules/* and are not part of the Django OpenAPI schema.
 */
import {
  consolidationConfigGet,
  consolidationRunnowPost,
  consolidationRunsGet,
  heartbeatConfigGet,
  heartbeatConfigPut,
  heartbeatRunnowPost,
  heartbeatRunsGet,
  retrospectiveConfigGet,
  retrospectiveRunsGet,
  schedulesByIdDelete,
  schedulesByIdPatch,
  schedulesByIdRunPost,
  schedulesByIdRunsGet,
  schedulesByIdTogglePost,
  schedulesUsagesummaryGet,
  schedulesPost,
} from "@/generated/daemon/sdk.gen";
import type {
  ConsolidationConfigGetResponse,
  ConsolidationRunnowPostResponse,
  HeartbeatConfigGetResponse,
  HeartbeatConfigPutResponse,
  HeartbeatRunnowPostResponse,
  RetrospectiveConfigGetResponse,
} from "@/generated/daemon/types.gen";
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

export async function fetchHeartbeatRuns(
  assistantId: string,
  limit = 10,
  before?: number,
): Promise<ScheduleRunsPage> {
  const { data, error, response } = await heartbeatRunsGet({
    path: { assistant_id: assistantId },
    query: { limit, before },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load heartbeat runs.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to load heartbeat runs."),
    );
  }
  return {
    nextCursor: data?.nextCursor ?? null,
    runs: (data?.runs ?? []).map((run) => ({
      id: run.id,
      jobId: "heartbeat",
      status: run.status,
      startedAt: run.startedAt ?? run.scheduledFor,
      finishedAt: run.finishedAt,
      durationMs: run.durationMs,
      output: run.skipReason ? `Skipped: ${run.skipReason}` : null,
      error: run.error,
      conversationId: run.conversationId,
      conversationExists: run.conversationExists,
      conversationArchivedAt: run.conversationArchivedAt,
      estimatedCostUsd: run.estimatedCostUsd,
      createdAt: run.createdAt,
    })),
  };
}

export async function fetchConsolidationRuns(
  assistantId: string,
  limit = 10,
  before?: number,
): Promise<ScheduleRunsPage> {
  const { data, error, response } = await consolidationRunsGet({
    path: { assistant_id: assistantId },
    query: { limit, before },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load consolidation runs.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to load consolidation runs."),
    );
  }
  return {
    nextCursor: data?.nextCursor ?? null,
    runs: (data?.runs ?? []).map((run) => ({
      id: run.id,
      jobId: "consolidation",
      status: run.status,
      startedAt: run.startedAt ?? run.scheduledFor,
      finishedAt: run.finishedAt,
      durationMs: run.durationMs,
      output: null,
      error: run.error,
      conversationId: run.conversationId,
      conversationExists: run.conversationExists,
      conversationArchivedAt: run.conversationArchivedAt,
      estimatedCostUsd: run.estimatedCostUsd,
      createdAt: run.createdAt,
    })),
  };
}

export async function fetchRetrospectiveRuns(
  assistantId: string,
  limit = 10,
  before?: number,
): Promise<ScheduleRunsPage> {
  const { data, error, response } = await retrospectiveRunsGet({
    path: { assistant_id: assistantId },
    query: { limit, before },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load retrospective runs.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to load retrospective runs."),
    );
  }
  return {
    nextCursor: data?.nextCursor ?? null,
    runs: (data?.runs ?? []).map((run) => ({
      id: run.id,
      jobId: "retrospective",
      status: run.status,
      startedAt: run.startedAt ?? run.scheduledFor,
      finishedAt: run.finishedAt,
      durationMs: run.durationMs,
      output: null,
      error: run.error,
      conversationId: run.conversationId,
      conversationExists: run.conversationExists,
      conversationArchivedAt: run.conversationArchivedAt,
      estimatedCostUsd: run.estimatedCostUsd,
      createdAt: run.createdAt,
      title: run.title,
    })),
  };
}

export async function fetchHeartbeatConfig(
  assistantId: string,
): Promise<HeartbeatConfigGetResponse> {
  const { data, error, response } = await heartbeatConfigGet({
    path: { assistant_id: assistantId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load heartbeat config.");
  if (!response.ok || !data) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to load heartbeat config."),
    );
  }
  return data;
}

export interface UpdateSystemTaskConfigPayload {
  enabled: boolean;
}

async function updateSystemTaskConfig<TResponse>(
  request: () => Promise<{
    data?: TResponse;
    error?: unknown;
    response?: Response;
  }>,
  failureMessage: string,
): Promise<TResponse> {
  const { data, error, response } = await request();
  assertHasResponse(response, error, failureMessage);
  if (!response.ok || !data) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, failureMessage),
    );
  }
  return data;
}

export async function updateHeartbeatConfig(
  assistantId: string,
  payload: UpdateSystemTaskConfigPayload,
): Promise<HeartbeatConfigPutResponse> {
  return updateSystemTaskConfig(
    () =>
      heartbeatConfigPut({
        path: { assistant_id: assistantId },
        body: payload,
        throwOnError: false,
      }),
    "Failed to update heartbeat config.",
  );
}

export async function runHeartbeatNow(
  assistantId: string,
): Promise<HeartbeatRunnowPostResponse> {
  const { data, error, response } = await heartbeatRunnowPost({
    path: { assistant_id: assistantId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to run heartbeat.");
  if (!response.ok || !data) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to run heartbeat."),
    );
  }
  return data;
}

export async function fetchConsolidationConfig(
  assistantId: string,
): Promise<ConsolidationConfigGetResponse> {
  const { data, error, response } = await consolidationConfigGet({
    path: { assistant_id: assistantId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load consolidation config.");
  if (!response.ok || !data) {
    throw new ApiError(
      response.status,
      extractErrorMessage(
        error,
        response,
        "Failed to load consolidation config.",
      ),
    );
  }
  return data;
}

export async function fetchRetrospectiveConfig(
  assistantId: string,
): Promise<RetrospectiveConfigGetResponse> {
  const { data, error, response } = await retrospectiveConfigGet({
    path: { assistant_id: assistantId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load retrospective config.");
  if (!response.ok || !data) {
    throw new ApiError(
      response.status,
      extractErrorMessage(
        error,
        response,
        "Failed to load retrospective config.",
      ),
    );
  }
  return data;
}

export async function runConsolidationNow(
  assistantId: string,
): Promise<ConsolidationRunnowPostResponse> {
  const { data, error, response } = await consolidationRunnowPost({
    path: { assistant_id: assistantId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to run consolidation.");
  if (!response.ok || !data) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to run consolidation."),
    );
  }
  return data;
}
