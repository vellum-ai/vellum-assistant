/**
 * Fetch wrappers for the daemon's usage endpoints. Consumes the generated
 * daemon SDK; the response types are derived from the routes' declared schemas.
 */

import {
  usageBreakdownGet,
  usageDailyGet,
  usageSeriesGet,
  usageTotalsGet,
} from "@/generated/daemon/sdk.gen";
import type {
  UsageBreakdownGetData,
  UsageDailyGetData,
  UsageSeriesGetData,
  UsageTotalsGetData,
} from "@/generated/daemon/types.gen";

import { isLlmUsageDimension, toDaemonGroupBy } from "@/utils/llm-dimension";
import type {
  UsageBreakdownResponse,
  UsageDailyResponse,
  UsageGranularity,
  UsageGroupBy,
  UsageSeriesGroupBy,
  UsageSeriesResponse,
  UsageTotals,
} from "./usage-types";

export class UsageRequestError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "UsageRequestError";
    this.status = status;
  }
}

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
  scheduleId?: string;
}

export interface FetchUsageDailyParams {
  from: number;
  to: number;
  granularity?: UsageGranularity;
  tz?: string;
  scheduleId?: string;
}

export interface FetchUsageBreakdownParams {
  from: number;
  to: number;
  groupBy: UsageGroupBy;
  scheduleId?: string;
}

export interface FetchUsageSeriesParams {
  from: number;
  to: number;
  granularity: UsageGranularity;
  groupBy: UsageSeriesGroupBy;
  tz?: string;
  scheduleId?: string;
}

export type UsageTotalsQuery = NonNullable<UsageTotalsGetData["query"]>;
export type UsageDailyQuery = NonNullable<UsageDailyGetData["query"]>;
export type UsageBreakdownQuery = NonNullable<UsageBreakdownGetData["query"]>;
export type UsageSeriesQuery = NonNullable<UsageSeriesGetData["query"]>;

function toUsageGroupByQueryValue(groupBy: UsageGroupBy): string {
  return isLlmUsageDimension(groupBy) ? toDaemonGroupBy(groupBy) : groupBy;
}

export function buildUsageTotalsQuery(
  params: FetchUsageTotalsParams,
): UsageTotalsQuery {
  const query: UsageTotalsQuery = {
    from: params.from,
    to: params.to,
  };
  return withScheduleId(query, params.scheduleId);
}

export function buildUsageDailyQuery(
  params: FetchUsageDailyParams,
): UsageDailyQuery {
  const query: UsageDailyQuery = {
    from: params.from,
    to: params.to,
    ...(params.granularity ? { granularity: params.granularity } : {}),
    ...(params.tz ? { tz: params.tz } : {}),
  };
  return withScheduleId(query, params.scheduleId);
}

export function buildUsageBreakdownQuery(
  params: FetchUsageBreakdownParams,
): UsageBreakdownQuery {
  const query: UsageBreakdownQuery = {
    from: params.from,
    to: params.to,
    groupBy: toUsageGroupByQueryValue(params.groupBy),
  };
  return withScheduleId(query, params.scheduleId);
}

export function buildUsageSeriesQuery(
  params: FetchUsageSeriesParams,
): UsageSeriesQuery {
  const query: UsageSeriesQuery = {
    from: params.from,
    to: params.to,
    granularity: params.granularity,
    groupBy: toUsageGroupByQueryValue(params.groupBy),
    ...(params.tz ? { tz: params.tz } : {}),
  };
  return withScheduleId(query, params.scheduleId);
}

function withScheduleId<T extends { scheduleId?: string }>(
  query: T,
  scheduleId: string | undefined,
): T {
  return scheduleId ? { ...query, scheduleId } : query;
}

async function throwOnBadResponse(
  response: Response | undefined,
  fallbackMessage: string,
): Promise<never> {
  const text = await response
    ?.clone()
    .text()
    .catch(() => "");
  throw new UsageRequestError(
    response?.status ?? 0,
    text || response?.statusText || fallbackMessage,
  );
}

export async function fetchUsageTotals(
  assistantId: string,
  params: FetchUsageTotalsParams,
): Promise<UsageTotals> {
  const { data, response } = await usageTotalsGet({
    path: { assistant_id: assistantId },
    query: buildUsageTotalsQuery(params),
    throwOnError: false,
  });
  if (!response?.ok) {
    return throwOnBadResponse(response, "Failed to load usage totals.");
  }
  return { ...EMPTY_TOTALS, ...data };
}

export async function fetchUsageDaily(
  assistantId: string,
  params: FetchUsageDailyParams,
): Promise<UsageDailyResponse> {
  const { data, response } = await usageDailyGet({
    path: { assistant_id: assistantId },
    query: buildUsageDailyQuery(params),
    throwOnError: false,
  });
  if (!response?.ok) {
    return throwOnBadResponse(response, "Failed to load usage buckets.");
  }
  const buckets = data?.buckets ?? [];
  return {
    buckets: buckets.map((bucket) => ({
      ...bucket,
      bucketId: bucket.bucketId ?? bucket.date,
    })),
  };
}

export async function fetchUsageBreakdown(
  assistantId: string,
  params: FetchUsageBreakdownParams,
): Promise<UsageBreakdownResponse> {
  const { data, response } = await usageBreakdownGet({
    path: { assistant_id: assistantId },
    query: buildUsageBreakdownQuery(params),
    throwOnError: false,
  });
  if (!response?.ok) {
    return throwOnBadResponse(response, "Failed to load usage breakdown.");
  }
  return { breakdown: data?.breakdown ?? [] };
}

export async function fetchUsageSeries(
  assistantId: string,
  params: FetchUsageSeriesParams,
): Promise<UsageSeriesResponse> {
  const { data, response } = await usageSeriesGet({
    path: { assistant_id: assistantId },
    query: buildUsageSeriesQuery(params),
    throwOnError: false,
  });
  if (!response?.ok) {
    return throwOnBadResponse(response, "Failed to load usage series.");
  }
  const seriesBuckets = data?.buckets ?? [];
  return {
    buckets: seriesBuckets.map((bucket) => ({
      ...bucket,
      bucketId: bucket.bucketId ?? bucket.date,
      groups: bucket.groups ?? {},
    })),
  };
}
