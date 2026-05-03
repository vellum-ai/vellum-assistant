/**
 * Shared types for the LLM usage tracking layer.
 *
 * Extracted from llm-usage-store.ts to break circular imports between
 * the store and its bucket-aggregation helpers (usage-buckets.ts,
 * usage-grouped-buckets.ts).
 */

export interface UsageTimeRange {
  from: number;
  to: number;
}

/** A single time bucket with its aggregate totals. */
export interface UsageDayBucket {
  /**
   * Stable unique identifier for the bucket. Safe for use as a SwiftUI/React
   * list key. Distinct even for DST fall-back duplicate hours (which share the
   * same `date` string). Daily buckets use `date` directly; hourly buckets use
   * "YYYY-MM-DD HH:00|<offsetMinutes>" to disambiguate repeated local hours.
   */
  bucketId: string;
  /**
   * Local-time bucket key in the requested tz:
   * "YYYY-MM-DD" (daily) or "YYYY-MM-DD HH:00" (hourly).
   * NOT unique: on DST fall-back days, two 01:00 hourly buckets share this key.
   * Use `bucketId` as a list identifier and `date` for display/sort only.
   */
  date: string;
  /**
   * Human-readable label for the bucket, formatted in the requested tz.
   * Hourly: "3pm". Daily: "Apr 11".
   */
  displayLabel?: string;
  /** Direct input tokens only; cache traffic is tracked separately in totals. */
  totalInputTokens: number;
  totalOutputTokens: number;
  totalEstimatedCostUsd: number;
  eventCount: number;
}

export interface UsageBucketOptions {
  /**
   * When true, emit a zero-value bucket for every day (or hour) in the range
   * even if no events fall inside it. Defaults to false so the CLI and other
   * callers only see active periods; the chart route opts in.
   */
  fillEmpty?: boolean;
}

export const USAGE_GROUP_BY_DIMENSIONS = [
  "actor",
  "provider",
  "model",
  "conversation",
  "call_site",
  "inference_profile",
] as const;

export type GroupByDimension = (typeof USAGE_GROUP_BY_DIMENSIONS)[number];
