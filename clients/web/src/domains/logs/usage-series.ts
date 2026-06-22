import { isLlmUsageDimension, toDaemonGroupBy } from "@/utils/llm-dimension";
import type { UsageGroupLabelMetadata } from "./group-labels";
import { resolveUsageGroupLabel } from "./group-labels";
import type {
  UsageGroupBreakdown,
  UsageSeriesBucket,
  UsageSeriesGroupBy,
  UsageSeriesGroupValue,
} from "./usage-types";

const VISIBLE_LEGEND_ITEM_LIMIT = 6;
const VALUE_GROUP_PREFIX = "value:";
const NULL_GROUP_PREFIX = "null:";

export interface UsageSeriesLegendItem {
  seriesKey: string;
  label: string;
  totalEstimatedCostUsd: number;
  colorIndex: number;
}

export interface UsageSeriesLegend {
  items: UsageSeriesLegendItem[];
  visibleItems: UsageSeriesLegendItem[];
}

/**
 * Mirrors the backend's grouped-series key shape so filtered charts can keep
 * legend items aligned with the buckets returned by the usage series route.
 */
export function usageSeriesKeyForGroupValue(
  groupKey: string | null,
  groupBy: UsageSeriesGroupBy = "schedule",
): string {
  if (groupKey !== null) {
    return `${VALUE_GROUP_PREFIX}${groupKey}`;
  }
  const backendGroupBy = isLlmUsageDimension(groupBy)
    ? toDaemonGroupBy(groupBy)
    : groupBy;
  return `${NULL_GROUP_PREFIX}${backendGroupBy}`;
}

export function sortUsageSeriesBuckets(
  buckets: readonly UsageSeriesBucket[],
): UsageSeriesBucket[] {
  return [...buckets].sort((lhs, rhs) => {
    if (lhs.date !== rhs.date) {
      return lhs.date < rhs.date ? -1 : 1;
    }

    const lhsOffset = offsetMinutes(lhs.bucketId);
    const rhsOffset = offsetMinutes(rhs.bucketId);
    if (lhsOffset !== rhsOffset) {
      return lhsOffset - rhsOffset;
    }

    if (lhs.bucketId === rhs.bucketId) {
      return 0;
    }
    return lhs.bucketId < rhs.bucketId ? -1 : 1;
  });
}

export function seriesFromDailyBuckets(
  buckets: readonly import("./usage-types").UsageDayBucket[],
): UsageSeriesBucket[] {
  return buckets.map((bucket) => ({
    bucketId: bucket.bucketId,
    date: bucket.date,
    displayLabel: bucket.displayLabel,
    totalInputTokens: bucket.totalInputTokens,
    totalOutputTokens: bucket.totalOutputTokens,
    totalEstimatedCostUsd: bucket.totalEstimatedCostUsd,
    eventCount: bucket.eventCount,
    groups: {},
  }));
}

export function decorateUsageSeriesGroups(
  buckets: readonly UsageSeriesBucket[],
  groupBy: UsageSeriesGroupBy,
  metadata: UsageGroupLabelMetadata,
): UsageSeriesBucket[] {
  if (groupBy !== "task" && groupBy !== "profile") {
    return [...buckets];
  }

  return buckets.map((bucket) => {
    let changed = false;
    const groups: Record<string, UsageSeriesGroupValue> = {};

    for (const [seriesKey, value] of Object.entries(bucket.groups)) {
      const label = resolveUsageGroupLabel(
        groupBy,
        seriesGroupValueToBreakdown(value),
        metadata,
      );
      if (label === value.group) {
        groups[seriesKey] = value;
      } else {
        changed = true;
        groups[seriesKey] = {
          ...value,
          group: label,
        };
      }
    }

    if (!changed) {
      return bucket;
    }

    return {
      ...bucket,
      groups,
    };
  });
}

export function buildUsageSeriesLegend(
  buckets: readonly UsageSeriesBucket[],
): UsageSeriesLegend {
  const totals = new Map<
    string,
    { label: string; totalEstimatedCostUsd: number }
  >();

  for (const bucket of buckets) {
    for (const [seriesKey, value] of Object.entries(bucket.groups)) {
      const current = totals.get(seriesKey);
      totals.set(seriesKey, {
        label: current?.label ?? value.group,
        totalEstimatedCostUsd:
          (current?.totalEstimatedCostUsd ?? 0) +
          value.totalEstimatedCostUsd,
      });
    }
  }

  const items = Array.from(totals.entries())
    .sort(([lhsKey, lhs], [rhsKey, rhs]) => {
      if (lhs.totalEstimatedCostUsd !== rhs.totalEstimatedCostUsd) {
        return rhs.totalEstimatedCostUsd - lhs.totalEstimatedCostUsd;
      }
      if (lhs.label !== rhs.label) {
        return lhs.label < rhs.label ? -1 : 1;
      }
      if (lhsKey === rhsKey) {
        return 0;
      }
      return lhsKey < rhsKey ? -1 : 1;
    })
    .map(([seriesKey, value], colorIndex) => ({
      seriesKey,
      label: value.label,
      totalEstimatedCostUsd: value.totalEstimatedCostUsd,
      colorIndex,
    }));

  return {
    items,
    visibleItems: items.slice(0, VISIBLE_LEGEND_ITEM_LIMIT),
  };
}

function seriesGroupValueToBreakdown(
  value: UsageSeriesGroupValue,
): UsageGroupBreakdown {
  return {
    group: value.group,
    groupId: value.groupKey,
    groupKey: value.groupKey,
    totalInputTokens: value.totalInputTokens,
    totalOutputTokens: value.totalOutputTokens,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    totalEstimatedCostUsd: value.totalEstimatedCostUsd,
    eventCount: value.eventCount,
    // Series grouping never supports the conversation dimension, so turns are
    // always undefined for these synthesized rows.
    turnCount: null,
  };
}

function offsetMinutes(bucketId: string): number {
  const pipe = bucketId.lastIndexOf("|");
  if (pipe < 0) {
    return 0;
  }

  const parsed = Number(bucketId.slice(pipe + 1));
  return Number.isFinite(parsed) ? parsed : 0;
}
