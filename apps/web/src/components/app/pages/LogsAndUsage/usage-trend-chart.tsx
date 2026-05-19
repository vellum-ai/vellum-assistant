
import { useCallback, useMemo, useState, type MouseEvent } from "react";

import {
  buildUsageSeriesLegend,
  sortUsageSeriesBuckets,
  type UsageSeriesLegendItem,
} from "@/components/app/pages/LogsAndUsage/usage-series.js";
import { formatCost } from "@/components/app/pages/LogsAndUsage/utils.js";
import type { UsageSeriesBucket } from "@/lib/usage/types.js";

const BAR_CHART_HEIGHT = 140;
const DAILY_BAR_WIDTH = 40;
const HOURLY_BAR_WIDTH = 28;
const MIN_BAR_HEIGHT = 2;
const MIN_SEGMENT_HEIGHT = 2;
const COST_DIVISOR_FLOOR = 0.000_001;
const TOOLTIP_OFFSET = 12;
const TOOLTIP_MAX_WIDTH = 220;
const TOOLTIP_ESTIMATED_HEIGHT = 56;
const DAILY_SKELETON_HEIGHTS = [40, 80, 60, 100, 50, 70, 30] as const;
const HOURLY_SKELETON_HEIGHTS = [
  18, 24, 28, 35, 42, 50, 64, 78, 92, 106, 118, 96, 84, 74, 68, 80, 88, 72,
  56, 48, 40, 34, 26, 20,
] as const;

const STACK_COLORS = [
  "var(--usage-trend-stack-positive, var(--system-positive-strong, #10b981))",
  "var(--usage-trend-stack-info, var(--system-info-strong, #3b82f6))",
  "var(--usage-trend-stack-mid, var(--system-mid-strong, #f59e0b))",
  "var(--usage-trend-stack-secondary, var(--content-secondary, #6b7280))",
  "var(--usage-trend-stack-negative, var(--system-negative-strong, #f87171))",
  "var(--usage-trend-stack-tertiary, var(--content-tertiary, #9ca3af))",
] as const;

type SegmentTooltip = {
  label: string;
  bucketLabel: string;
  cost: string;
  x: number;
  y: number;
};

type SegmentTooltipContent = Omit<SegmentTooltip, "x" | "y">;

export function UsageTrendChart({
  buckets,
  isHourly,
}: {
  buckets: UsageSeriesBucket[];
  isHourly: boolean;
}) {
  const [tooltip, setTooltip] = useState<SegmentTooltip | null>(null);
  const sorted = useMemo(() => sortUsageSeriesBuckets(buckets), [buckets]);
  const legend = useMemo(() => buildUsageSeriesLegend(buckets), [buckets]);
  const maxCost = useMemo(
    () =>
      sorted.reduce(
        (acc, bucket) => Math.max(acc, bucket.totalEstimatedCostUsd),
        0,
      ),
    [sorted],
  );
  const showTooltip = useCallback(
    (event: MouseEvent<HTMLElement>, content: SegmentTooltipContent) => {
      const position = resolveTooltipPosition(event.clientX, event.clientY);
      setTooltip({
        ...content,
        x: position.x,
        y: position.y,
      });
    },
    [],
  );
  const hideTooltip = useCallback(() => setTooltip(null), []);

  if (sorted.length === 0) {
    return (
      <EmptyState
        title={isHourly ? "No hourly data" : "No daily data"}
        subtitle="No usage recorded in this time range"
      />
    );
  }

  const barWidth = isHourly ? HOURLY_BAR_WIDTH : DAILY_BAR_WIDTH;

  return (
    <div className="overflow-x-auto">
      <div className="flex flex-col gap-2">
        <div
          className="flex items-end gap-2"
          style={{ height: `${BAR_CHART_HEIGHT}px` }}
          aria-hidden="true"
        >
          {sorted.map((bucket) => {
            const fraction =
              maxCost > 0 ? bucket.totalEstimatedCostUsd / maxCost : 0;
            const height = Math.max(
              MIN_BAR_HEIGHT,
              BAR_CHART_HEIGHT * fraction,
            );

            return (
              <div
                key={bucket.bucketId}
                className="flex items-end"
                style={{
                  width: `${barWidth}px`,
                  minWidth: `${barWidth}px`,
                  height: `${height}px`,
                  opacity: bucket.totalEstimatedCostUsd > 0 ? 1 : 0.3,
                }}
                title={`${formatBucketLabel(bucket)}: ${formatCost(
                  bucket.totalEstimatedCostUsd,
                )}`}
                data-usage-series-bar={bucket.bucketId}
              >
                <StackedBar
                  bucket={bucket}
                  height={height}
                  legendItems={legend.items}
                  onSegmentHover={showTooltip}
                  onSegmentLeave={hideTooltip}
                />
              </div>
            );
          })}
        </div>
        <div className="flex items-start gap-2">
          {sorted.map((bucket) => (
            <div
              key={bucket.bucketId}
              className="flex flex-col items-center gap-0.5"
              style={{
                width: `${barWidth}px`,
                minWidth: `${barWidth}px`,
              }}
            >
              <span
                // off-scale: 10/400 (dense usage chart cost label)
                className="truncate text-[10px]"
                style={{ color: "var(--content-secondary)" }}
              >
                {formatCost(bucket.totalEstimatedCostUsd)}
              </span>
              <span
                // off-scale: 10/400 (dense usage chart date label)
                className="truncate text-[10px]"
                style={{ color: "var(--content-tertiary)" }}
              >
                {formatBucketLabel(bucket)}
              </span>
            </div>
          ))}
        </div>
        {legend.visibleItems.length > 0 ? (
          <UsageSeriesLegend items={legend.visibleItems} />
        ) : null}
      </div>
      {tooltip ? <SegmentTooltipBubble tooltip={tooltip} /> : null}
    </div>
  );
}

export function UsageTrendSkeleton({ isHourly }: { isHourly: boolean }) {
  const heights = isHourly ? HOURLY_SKELETON_HEIGHTS : DAILY_SKELETON_HEIGHTS;
  const barWidth = isHourly ? HOURLY_BAR_WIDTH : DAILY_BAR_WIDTH;
  return (
    <div
      className="flex items-end gap-2"
      style={{ height: `${BAR_CHART_HEIGHT}px` }}
      aria-hidden="true"
    >
      {heights.map((height, index) => (
        <div
          key={index}
          className="rounded-sm"
          style={{
            width: `${barWidth}px`,
            height: `${height}px`,
            background:
              "color-mix(in srgb, var(--border-base) 40%, transparent)",
          }}
        />
      ))}
    </div>
  );
}

function StackedBar({
  bucket,
  height,
  legendItems,
  onSegmentHover,
  onSegmentLeave,
}: {
  bucket: UsageSeriesBucket;
  height: number;
  legendItems: UsageSeriesLegendItem[];
  onSegmentHover: (
    event: MouseEvent<HTMLElement>,
    content: SegmentTooltipContent,
  ) => void;
  onSegmentLeave: () => void;
}) {
  const nonEmptyGroups = legendItems.flatMap((item) => {
    const value = bucket.groups[item.seriesKey];
    if (!value || value.totalEstimatedCostUsd <= 0) {
      return [];
    }
    return [{ item, value }];
  });

  if (nonEmptyGroups.length === 0) {
    const bucketLabel = formatBucketLabel(bucket);
    const tooltipContent = {
      label: "Total",
      bucketLabel,
      cost: formatCost(bucket.totalEstimatedCostUsd),
    };
    return (
      <div
        className="w-full rounded-sm"
        title={`${tooltipContent.label}: ${tooltipContent.cost}`}
        onMouseEnter={(event) => onSegmentHover(event, tooltipContent)}
        onMouseMove={(event) => onSegmentHover(event, tooltipContent)}
        onMouseLeave={onSegmentLeave}
        style={{
          height: `${height}px`,
          background: colorForIndex(0),
        }}
        data-usage-series-segment-label={tooltipContent.label}
        data-usage-fallback-segment="true"
      />
    );
  }

  return (
    <div
      className="flex w-full flex-col-reverse overflow-hidden rounded-sm"
      style={{ height: `${height}px` }}
      data-usage-series-stack={bucket.bucketId}
    >
      {nonEmptyGroups.map(({ item, value }) => {
        const tooltipContent = {
          label: item.label,
          bucketLabel: formatBucketLabel(bucket),
          cost: formatCost(value.totalEstimatedCostUsd),
        };
        return (
          <div
            key={item.seriesKey}
            title={`${tooltipContent.label}: ${tooltipContent.cost}`}
            onMouseEnter={(event) => onSegmentHover(event, tooltipContent)}
            onMouseMove={(event) => onSegmentHover(event, tooltipContent)}
            onMouseLeave={onSegmentLeave}
            style={{
              height: `${Math.max(
                MIN_SEGMENT_HEIGHT,
                (height * value.totalEstimatedCostUsd) /
                  Math.max(bucket.totalEstimatedCostUsd, COST_DIVISOR_FLOOR),
              )}px`,
              background: colorForIndex(item.colorIndex),
            }}
            data-usage-series-segment={item.seriesKey}
            data-usage-series-segment-label={item.label}
          />
        );
      })}
    </div>
  );
}

function SegmentTooltipBubble({ tooltip }: { tooltip: SegmentTooltip }) {
  return (
    <div
      className="pointer-events-none fixed z-50 max-w-[220px] rounded-md border px-2 py-1 shadow-xl"
      style={{
        left: `${tooltip.x}px`,
        top: `${tooltip.y}px`,
        background: "var(--surface-overlay, var(--surface-lift))",
        borderColor: "var(--border-base)",
      }}
      aria-hidden="true"
    >
      <div
        className="truncate text-body-small-default"
        style={{ color: "var(--content-default)" }}
      >
        {tooltip.label}
      </div>
      <div
        className="truncate text-body-small-default"
        style={{ color: "var(--content-tertiary)" }}
      >
        {tooltip.bucketLabel} · {tooltip.cost}
      </div>
    </div>
  );
}

function UsageSeriesLegend({ items }: { items: UsageSeriesLegendItem[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1">
      {items.map((item) => (
        <div key={item.seriesKey} className="flex min-w-0 items-center gap-1">
          <span
            className="h-[7px] w-[7px] shrink-0 rounded-full"
            style={{ background: colorForIndex(item.colorIndex) }}
            aria-hidden="true"
          />
          <span
            className="truncate text-[10px]"
            style={{ color: "var(--content-tertiary)" }}
          >
            {item.label}
          </span>
        </div>
      ))}
    </div>
  );
}

function EmptyState({
  title,
  subtitle,
}: {
  title: string;
  subtitle: string;
}) {
  return (
    <div className="flex flex-col items-center gap-1 py-8 text-center">
      <span
        className="text-body-medium-default"
        style={{ color: "var(--content-default)" }}
      >
        {title}
      </span>
      <span
        className="text-body-small-default"
        style={{ color: "var(--content-tertiary)" }}
      >
        {subtitle}
      </span>
    </div>
  );
}

function formatBucketLabel(bucket: UsageSeriesBucket): string {
  return bucket.displayLabel ?? bucket.date;
}

function colorForIndex(index: number): string {
  return (
    STACK_COLORS[index % STACK_COLORS.length] ??
    "var(--system-positive-strong, #10b981)"
  );
}

function resolveTooltipPosition(clientX: number, clientY: number) {
  if (typeof window === "undefined") {
    return {
      x: clientX + TOOLTIP_OFFSET,
      y: clientY + TOOLTIP_OFFSET,
    };
  }

  const maxX = window.innerWidth - TOOLTIP_MAX_WIDTH - TOOLTIP_OFFSET;
  const x = Math.max(
    TOOLTIP_OFFSET,
    Math.min(clientX + TOOLTIP_OFFSET, maxX),
  );
  const belowY = clientY + TOOLTIP_OFFSET;
  const y =
    belowY + TOOLTIP_ESTIMATED_HEIGHT > window.innerHeight
      ? clientY - TOOLTIP_ESTIMATED_HEIGHT - TOOLTIP_OFFSET
      : belowY;

  return {
    x,
    y: Math.max(TOOLTIP_OFFSET, y),
  };
}
