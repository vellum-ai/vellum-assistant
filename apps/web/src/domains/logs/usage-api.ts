/**
 * Query-building helpers for the daemon's usage endpoints.
 * Translates client-facing group-by labels to the wire values the daemon
 * expects and appends optional schedule filters.
 *
 * Consumers pass the built query objects to generated SDK options factories
 * (e.g. `usageTotalsGetOptions({ path, query: buildUsageTotalsQuery(...) })`).
 */

import type {
  UsageBreakdownGetData,
  UsageDailyGetData,
  UsageSeriesGetData,
  UsageTotalsGetData,
} from "@/generated/daemon/types.gen";

import { isLlmUsageDimension, toDaemonGroupBy } from "@/utils/llm-dimension";
import type {
  UsageGranularity,
  UsageGroupBy,
  UsageSeriesGroupBy,
} from "./usage-types";

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
