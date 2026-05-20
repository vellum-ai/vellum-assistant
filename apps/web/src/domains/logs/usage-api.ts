/**
 * Hand-written fetch wrappers for the daemon's usage endpoints.
 * These are served via RuntimeProxyWildcardView under
 * /v1/assistants/{id}/usage/* and are not part of the Django OpenAPI schema,
 * so no generated HeyAPI hooks exist for them.
 */

import { client } from "@/generated/api/client.gen.js";

import {
  isLlmUsageDimension,
  toDaemonGroupBy,
} from "@/utils/llm-dimension.js";
import type {
  UsageBreakdownResponse,
  UsageDailyResponse,
  UsageGranularity,
  UsageGroupBy,
  UsageSeriesGroupBy,
  UsageSeriesResponse,
  UsageTotals,
} from "./usage-types.js";

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

function buildTotalsQuery(
  params: FetchUsageTotalsParams,
): Record<string, string> {
  return {
    from: String(params.from),
    to: String(params.to),
  };
}

function buildDailyQuery(
  params: FetchUsageDailyParams,
): Record<string, string> {
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
  const { data, response } = await client.get<UsageTotals>({
    url: "/v1/assistants/{assistant_id}/usage/totals",
    path: { assistant_id: assistantId },
    query: buildTotalsQuery(params),
    throwOnError: false,
  });
  if (!response || !response.ok) {
    return throwOnBadResponse(response, "Failed to load usage totals.");
  }
  return data ?? EMPTY_TOTALS;
}

export async function fetchUsageDaily(
  assistantId: string,
  params: FetchUsageDailyParams,
): Promise<UsageDailyResponse> {
  const { data, response } = await client.get<UsageDailyResponse>({
    url: "/v1/assistants/{assistant_id}/usage/daily",
    path: { assistant_id: assistantId },
    query: buildDailyQuery(params),
    throwOnError: false,
  });
  if (!response || !response.ok) {
    return throwOnBadResponse(response, "Failed to load usage buckets.");
  }
  if (!data) {
    return { buckets: [] };
  }
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
  const { data, response } = await client.get<UsageBreakdownResponse>({
    url: "/v1/assistants/{assistant_id}/usage/breakdown",
    path: { assistant_id: assistantId },
    query: buildBreakdownQuery(params),
    throwOnError: false,
  });
  if (!response || !response.ok) {
    return throwOnBadResponse(response, "Failed to load usage breakdown.");
  }
  return data ?? { breakdown: [] };
}

export async function fetchUsageSeries(
  assistantId: string,
  params: FetchUsageSeriesParams,
): Promise<UsageSeriesResponse> {
  const { data, response } = await client.get<UsageSeriesResponse>({
    url: "/v1/assistants/{assistant_id}/usage/series",
    path: { assistant_id: assistantId },
    query: buildSeriesQuery(params),
    throwOnError: false,
  });
  if (!response || !response.ok) {
    return throwOnBadResponse(response, "Failed to load usage series.");
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
