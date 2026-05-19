// Hand-written fetch wrappers intentionally — these endpoints are served by the
// assistant daemon via RuntimeProxyWildcardView under /v1/assistants/{id}/usage/*
// and are not part of the Django OpenAPI schema, so no generated HeyAPI hooks
// exist for them. Mirrors the pattern used by web/src/lib/memories/api.ts.
import { client } from "@/generated/api/client.gen.js";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/lib/api/errors.js";

import "@/lib/vellum-api/client.js";

import { isLlmUsageDimension, toDaemonGroupBy } from "@/lib/usage/llm-dimension.js";
import type {
  UsageBreakdownResponse,
  UsageDailyResponse,
  UsageGranularity,
  UsageGroupBy,
  UsageSeriesGroupBy,
  UsageSeriesResponse,
  UsageTotals,
} from "@/lib/usage/types.js";

export { ApiError };

const SDK_BASE_OPTIONS =
  typeof window === "undefined"
    ? ({ baseUrl: "http://localhost" } as const)
    : ({} as const);

const EMPTY_TOTALS: UsageTotals = {
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheCreationTokens: 0,
  totalCacheReadTokens: 0,
  totalEstimatedCostUsd: 0,
  eventCount: 0,
  pricedEventCount: 0,
  unpricedEventCount: 0,
};

export interface FetchUsageTotalsParams {
  from: number;
  to: number;
}

export interface FetchUsageDailyParams {
  from: number;
  to: number;
  granularity?: UsageGranularity;
  tz?: string;
}

export interface FetchUsageBreakdownParams {
  from: number;
  to: number;
  groupBy: UsageGroupBy;
}

export interface FetchUsageSeriesParams {
  from: number;
  to: number;
  granularity: UsageGranularity;
  groupBy: UsageSeriesGroupBy;
  tz?: string;
}

function buildTotalsQuery(params: FetchUsageTotalsParams): Record<string, string> {
  return {
    from: String(params.from),
    to: String(params.to),
  };
}

function buildDailyQuery(params: FetchUsageDailyParams): Record<string, string> {
  const query: Record<string, string> = {
    from: String(params.from),
    to: String(params.to),
  };
  if (params.granularity) {
    query.granularity = params.granularity;
  }
  if (params.tz) {
    query.tz = params.tz;
  }
  return query;
}

function toUsageGroupByQueryValue(groupBy: UsageGroupBy): string {
  return isLlmUsageDimension(groupBy) ? toDaemonGroupBy(groupBy) : groupBy;
}

// Exported for tests to lock the friendly web vocabulary to daemon wire format.
export function buildBreakdownQuery(
  params: FetchUsageBreakdownParams,
): Record<string, string> {
  return {
    from: String(params.from),
    to: String(params.to),
    groupBy: toUsageGroupByQueryValue(params.groupBy),
  };
}

export function buildSeriesQuery(
  params: FetchUsageSeriesParams,
): Record<string, string> {
  const query: Record<string, string> = {
    from: String(params.from),
    to: String(params.to),
    granularity: params.granularity,
    groupBy: toUsageGroupByQueryValue(params.groupBy),
  };
  if (params.tz) {
    query.tz = params.tz;
  }
  return query;
}

export async function fetchUsageTotals(
  assistantId: string,
  params: FetchUsageTotalsParams,
): Promise<UsageTotals> {
  const { data, error, response } = await client.get<UsageTotals, unknown>({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/usage/totals",
    path: { assistant_id: assistantId },
    query: buildTotalsQuery(params),
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load usage totals.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to load usage totals."),
    );
  }
  return data ?? EMPTY_TOTALS;
}

export async function fetchUsageDaily(
  assistantId: string,
  params: FetchUsageDailyParams,
): Promise<UsageDailyResponse> {
  const { data, error, response } = await client.get<
    UsageDailyResponse,
    unknown
  >({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/usage/daily",
    path: { assistant_id: assistantId },
    query: buildDailyQuery(params),
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load usage buckets.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to load usage buckets."),
    );
  }
  if (!data) {
    return { buckets: [] };
  }
  // Older daemons may omit `bucketId`; fall back to `date` so downstream
  // consumers can rely on a non-empty string identifier. Mirrors the Swift
  // client's decode behavior in clients/shared/Network/UsageModels.swift.
  return {
    ...data,
    buckets: data.buckets.map((bucket) => ({
      ...bucket,
      bucketId: bucket.bucketId ?? bucket.date,
    })),
  };
}

export async function fetchUsageBreakdown(
  assistantId: string,
  params: FetchUsageBreakdownParams,
): Promise<UsageBreakdownResponse> {
  const { data, error, response } = await client.get<
    UsageBreakdownResponse,
    unknown
  >({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/usage/breakdown",
    path: { assistant_id: assistantId },
    query: buildBreakdownQuery(params),
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load usage breakdown.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to load usage breakdown."),
    );
  }
  return data ?? { breakdown: [] };
}

export async function fetchUsageSeries(
  assistantId: string,
  params: FetchUsageSeriesParams,
): Promise<UsageSeriesResponse> {
  const { data, error, response } = await client.get<
    UsageSeriesResponse,
    unknown
  >({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/usage/series",
    path: { assistant_id: assistantId },
    query: buildSeriesQuery(params),
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load usage series.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to load usage series."),
    );
  }
  if (!data) {
    return { buckets: [] };
  }
  return {
    ...data,
    buckets: data.buckets.map((bucket) => ({
      ...bucket,
      bucketId: bucket.bucketId ?? bucket.date,
      groups: bucket.groups ?? {},
    })),
  };
}
