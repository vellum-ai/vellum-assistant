/**
 * Type definitions for web-facing assistant usage data. These endpoints are
 * served by the daemon via RuntimeProxyWildcardView under
 * /v1/assistants/{id}/usage/* and are not part of the Django OpenAPI schema,
 * so we maintain types by hand here. UsageGroupBy values are picker-facing
 * labels; the API module translates `task` and `profile` to daemon wire
 * values at the boundary.
 */

export type UsageTimeRange = "today" | "7d" | "30d" | "90d" | "all";

export type UsageGranularity = "daily" | "hourly";

export type UsageGroupBy =
  | "actor"
  | "provider"
  | "model"
  | "conversation"
  | "task"
  | "profile";

export type UsageSeriesGroupBy = Exclude<UsageGroupBy, "conversation">;

export interface UsageTotals {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  totalEstimatedCostUsd: number;
  eventCount: number;
  pricedEventCount: number;
  unpricedEventCount: number;
}

export interface UsageDayBucket {
  bucketId: string;
  date: string;
  displayLabel?: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalEstimatedCostUsd: number;
  eventCount: number;
}

export interface UsageGroupBreakdown {
  group: string;
  groupId: string | null;
  groupKey?: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  totalEstimatedCostUsd: number;
  eventCount: number;
}

export interface UsageSeriesGroupValue {
  group: string;
  groupKey: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalEstimatedCostUsd: number;
  eventCount: number;
}

export interface UsageSeriesBucket {
  bucketId: string;
  date: string;
  displayLabel?: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalEstimatedCostUsd: number;
  eventCount: number;
  groups: Record<string, UsageSeriesGroupValue>;
}

export interface UsageDailyResponse {
  buckets: UsageDayBucket[];
}

export interface UsageBreakdownResponse {
  breakdown: UsageGroupBreakdown[];
}

export interface UsageSeriesResponse {
  buckets: UsageSeriesBucket[];
}
