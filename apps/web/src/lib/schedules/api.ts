// Hand-written fetch wrappers — these endpoints are served by the assistant
// daemon via RuntimeProxyView under /v1/assistants/{id}/schedules/* and are not
// part of the Django OpenAPI schema. Mirrors the trust-rules API pattern.
import { client } from "@/generated/api/client.gen.js";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/lib/api/errors.js";

import "@/lib/vellum-api/client.js";

import type {
  ConsolidationConfigResponse,
  HeartbeatConfigResponse,
  HeartbeatRunsResponse,
  RunNowResponse,
  Schedule,
  ScheduleRun,
  ScheduleRunsResponse,
  SchedulesListResponse,
} from "@/lib/schedules/types.js";

export { ApiError };

const SDK_BASE_OPTIONS =
  typeof window === "undefined"
    ? ({ baseUrl: "http://localhost" } as const)
    : ({} as const);

export interface CreateSchedulePayload {
  name: string;
  expression: string;
  message: string;
  timezone?: string | null;
  enabled?: boolean;
}

export async function createSchedule(
  assistantId: string,
  payload: CreateSchedulePayload,
): Promise<void> {
  // The backend returns the updated schedule list on success, but callers
  // don't need it — use fetchSchedules() if you need the created schedule.
  const { error, response } = await client.post<SchedulesListResponse, unknown>(
    {
      ...SDK_BASE_OPTIONS,
      url: "/v1/assistants/{assistant_id}/schedules/",
      path: { assistant_id: assistantId },
      body: payload,
      headers: { "Content-Type": "application/json" },
      throwOnError: false,
    },
  );
  assertHasResponse(response, error, "Failed to create schedule.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to create schedule."),
    );
  }
}

export async function fetchSchedules(assistantId: string): Promise<Schedule[]> {
  const { data, error, response } = await client.get<
    SchedulesListResponse,
    unknown
  >({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/schedules/",
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
  return data?.schedules ?? [];
}

export async function fetchScheduleRuns(
  assistantId: string,
  scheduleId: string,
  limit = 10,
): Promise<ScheduleRun[]> {
  const { data, error, response } = await client.get<
    ScheduleRunsResponse,
    unknown
  >({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/schedules/{schedule_id}/runs/",
    path: { assistant_id: assistantId, schedule_id: scheduleId },
    query: { limit },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load schedule runs.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to load schedule runs."),
    );
  }
  return data?.runs ?? [];
}

export async function toggleSchedule(
  assistantId: string,
  scheduleId: string,
  enabled: boolean,
): Promise<void> {
  const { error, response } = await client.post<unknown, unknown>({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/schedules/{schedule_id}/toggle/",
    path: { assistant_id: assistantId, schedule_id: scheduleId },
    body: { enabled },
    headers: { "Content-Type": "application/json" },
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
  const { error, response } = await client.delete<unknown, unknown>({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/schedules/{schedule_id}/",
    path: { assistant_id: assistantId, schedule_id: scheduleId },
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
  const { error, response } = await client.post<unknown, unknown>({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/schedules/{schedule_id}/run/",
    path: { assistant_id: assistantId, schedule_id: scheduleId },
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
): Promise<ScheduleRun[]> {
  const { data, error, response } = await client.get<
    HeartbeatRunsResponse,
    unknown
  >({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/heartbeat/runs/",
    path: { assistant_id: assistantId },
    query: { limit },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load heartbeat runs.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to load heartbeat runs."),
    );
  }
  return (data?.runs ?? []).map((run) => ({
    id: run.id,
    jobId: "heartbeat",
    status: run.status,
    startedAt: run.startedAt ?? run.scheduledFor,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs,
    output: run.skipReason ? `Skipped: ${run.skipReason}` : null,
    error: run.error,
    conversationId: run.conversationId,
    createdAt: run.createdAt,
  }));
}

export async function fetchHeartbeatConfig(
  assistantId: string,
): Promise<HeartbeatConfigResponse> {
  const { data, error, response } = await client.get<
    HeartbeatConfigResponse,
    unknown
  >({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/heartbeat/config/",
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

export async function runHeartbeatNow(
  assistantId: string,
): Promise<RunNowResponse> {
  const { data, error, response } = await client.post<RunNowResponse, unknown>({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/heartbeat/run-now/",
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
): Promise<ConsolidationConfigResponse> {
  const { data, error, response } = await client.get<
    ConsolidationConfigResponse,
    unknown
  >({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/consolidation/config/",
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

export async function runConsolidationNow(
  assistantId: string,
): Promise<RunNowResponse> {
  const { data, error, response } = await client.post<RunNowResponse, unknown>({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/consolidation/run-now/",
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
