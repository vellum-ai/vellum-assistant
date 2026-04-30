import { getLLMCallSiteLabel } from "../config/llm-callsite-catalog.js";
import type {
  GroupByDimension,
  UsageBucketOptions,
  UsageDayBucket,
  UsageTimeRange,
} from "./llm-usage-store.js";
import {
  bucketEventsByDay,
  bucketEventsByHour,
  compareUsageBuckets,
  type UsageEventBucketRow,
} from "./usage-buckets.js";

export interface UsageSeriesGroupValue {
  group: string;
  groupKey: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalEstimatedCostUsd: number;
  eventCount: number;
}

export interface UsageGroupedSeriesBucket extends UsageDayBucket {
  groups: Record<string, UsageSeriesGroupValue>;
}

export interface UsageGroupedBucketRow extends UsageEventBucketRow {
  group_key: string | null;
}

const VALUE_GROUP_PREFIX = "value:";
const NULL_GROUP_PREFIX = "null:";

export function displayUsageGroup(
  groupBy: GroupByDimension,
  groupKey: string | null,
): string {
  if (groupBy === "call_site") {
    return groupKey === null ? "Unknown Task" : getLLMCallSiteLabel(groupKey);
  }
  if (groupBy === "inference_profile") {
    return groupKey === null ? "Default / Unset" : groupKey;
  }
  return groupKey ?? "Other";
}

export function stableUsageSeriesGroupKey(
  groupBy: GroupByDimension,
  groupKey: string | null,
): string {
  if (groupKey !== null) return `${VALUE_GROUP_PREFIX}${groupKey}`;
  return `${NULL_GROUP_PREFIX}${groupBy}`;
}

function createEmptyGroupedBucket(
  bucket: UsageDayBucket,
): UsageGroupedSeriesBucket {
  return {
    bucketId: bucket.bucketId,
    date: bucket.date,
    displayLabel: bucket.displayLabel,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCostUsd: 0,
    eventCount: 0,
    groups: {},
  };
}

export function bucketGroupedUsageEvents(
  rows: UsageGroupedBucketRow[],
  range: UsageTimeRange,
  tz: string,
  options: UsageBucketOptions & {
    granularity: "daily" | "hourly";
    groupBy: GroupByDimension;
  },
): UsageGroupedSeriesBucket[] {
  const bucketEvents =
    options.granularity === "hourly" ? bucketEventsByHour : bucketEventsByDay;
  const baseBuckets = bucketEvents([], range, tz, {
    fillEmpty: options.fillEmpty,
  });
  const buckets = new Map<string, UsageGroupedSeriesBucket>();

  for (const bucket of baseBuckets) {
    buckets.set(bucket.bucketId, createEmptyGroupedBucket(bucket));
  }

  for (const row of rows) {
    const [bucket] = bucketEvents([row], range, tz);
    if (!bucket) continue;

    let groupedBucket = buckets.get(bucket.bucketId);
    if (!groupedBucket) {
      groupedBucket = createEmptyGroupedBucket(bucket);
      buckets.set(bucket.bucketId, groupedBucket);
    }

    const seriesKey = stableUsageSeriesGroupKey(options.groupBy, row.group_key);
    let group = groupedBucket.groups[seriesKey];
    if (!group) {
      group = {
        group: displayUsageGroup(options.groupBy, row.group_key),
        groupKey: row.group_key,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalEstimatedCostUsd: 0,
        eventCount: 0,
      };
      groupedBucket.groups[seriesKey] = group;
    }

    group.totalInputTokens += row.input_tokens;
    group.totalOutputTokens += row.output_tokens;
    group.totalEstimatedCostUsd += row.estimated_cost_usd ?? 0;
    group.eventCount += row.llm_call_count ?? 1;

    groupedBucket.totalInputTokens += row.input_tokens;
    groupedBucket.totalOutputTokens += row.output_tokens;
    groupedBucket.totalEstimatedCostUsd += row.estimated_cost_usd ?? 0;
    groupedBucket.eventCount += row.llm_call_count ?? 1;
  }

  return Array.from(buckets.values()).sort(compareUsageBuckets);
}
