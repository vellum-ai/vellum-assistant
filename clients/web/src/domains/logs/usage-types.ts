/**
 * Type definitions for web-facing assistant usage data. The wire response
 * shapes are derived from the generated daemon SDK types so they cannot drift
 * from the route's declared schema. The picker-facing enums below are
 * client-only: `UsageGroupBy` values are display labels; the API module
 * translates `task` and `profile` to daemon wire values at the boundary.
 */

import type {
  UsageBreakdownGetResponse,
  UsageDailyGetResponse,
  UsageSeriesGetResponse,
  UsageTotalsGetResponse,
} from "@/generated/daemon/types.gen";

export type UsageTimeRange = "today" | "7d" | "30d" | "90d" | "all";

export type UsageGranularity = "daily" | "hourly";

export type UsageGroupBy =
  | "actor"
  | "provider"
  | "model"
  | "conversation"
  | "task"
  | "profile"
  | "schedule";

export type UsageSeriesGroupBy = Exclude<UsageGroupBy, "conversation">;

export type UsageTotals = UsageTotalsGetResponse;

export type UsageDailyResponse = UsageDailyGetResponse;
export type UsageDayBucket = UsageDailyGetResponse["buckets"][number];

export type UsageBreakdownResponse = UsageBreakdownGetResponse;
export type UsageGroupBreakdown =
  UsageBreakdownGetResponse["breakdown"][number];

export type UsageSeriesResponse = UsageSeriesGetResponse;
export type UsageSeriesBucket = UsageSeriesGetResponse["buckets"][number];
export type UsageSeriesGroupValue = UsageSeriesBucket["groups"][string];
