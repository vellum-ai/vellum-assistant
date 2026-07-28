import { useCallback, useMemo, useState, type MouseEvent } from "react";

import { formatCost } from "@/domains/settings/billing/usage/format";
import {
  buildUsageSeriesLegend,
  sortUsageSeriesBuckets,
  type UsageSeriesLegendItem,
} from "@/domains/settings/billing/usage/usage-series";
import type { UsageSeriesBucket } from "@/domains/settings/billing/usage/usage-types";

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
type UsageLegendState = "active" | "inactive";

export type UsageTrendChartLegendItem = Pick<
  UsageSeriesLegendItem,
  "seriesKey" | "label" | "colorIndex"
> & {
  state?: UsageLegendState;
};

interface UsageTrendChartProps {
  buckets: UsageSeriesBucket[];
  isHourly: boolean;
  legendItems?: UsageTrendChartLegendItem[];
}

function colorForIndex(index: number): string {
  return STACK_COLORS[index % STACK_COLORS.length];
}

function formatBucketLabel(bucket: UsageSeriesBucket): string {
  if (bucket.displayLabel) {
    return bucket.displayLabel;
  }
  return bucket.date;
}

function resolveTooltipPosition(
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  let x = clientX + TOOLTIP_OFFSET;
  let y = clientY + TOOLTIP_OFFSET;

  if (x + TOOLTIP_MAX_WIDTH > window.innerWidth) {
    x = clientX - TOOLTIP_MAX_WIDTH - TOOLTIP_OFFSET;
  }
  if (y + TOOLTIP_ESTIMATED_HEIGHT > window.innerHeight) {
    y = clientY - TOOLTIP_ESTIMATED_HEIGHT - TOOLTIP_OFFSET;
  }
  return { x, y };
}

export function UsageTrendChart({
  buckets,
  isHourly,
  legendItems,
}: UsageTrendChartProps) {
  const [tooltip, setTooltip] = useState<SegmentTooltip | null>(null);
  const sorted = useMemo(() => sortUsageSeriesBuckets(buckets), [buckets]);
  const bucketLegend = useMemo(() => buildUsageSeriesLegend(buckets), [buckets]);
  const stackLegendItems = legendItems ?? bucketLegend.items;
  const visibleLegendItems = legendItems ?? bucketLegend.visibleItems;
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
    const emptyState = (
      <EmptyState
        title={isHourly ? "No hourly data" : "No daily data"}
        subtitle="No usage recorded in this time range"
      />
    );
    if (visibleLegendItems.length === 0) {
      return emptyState;
    }
    return (
      <div className="flex flex-col gap-2">
        {emptyState}
        <UsageSeriesLegendDisplay items={visibleLegendItems} />
      </div>
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
                title={`${formatBucketLabel(bucket)}: ${formatCost(bucket.totalEstimatedCostUsd)}`}
                data-usage-series-bar={bucket.bucketId}
              >
                <StackedBar
                  bucket={bucket}
                  height={height}
                  legendItems={stackLegendItems}
                  hasLegendOverride={legendItems != null}
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
                className="truncate text-[10px]"
                style={{ color: "var(--content-secondary)" }}
              >
                {formatCost(bucket.totalEstimatedCostUsd)}
              </span>
              <span
                className="truncate text-[10px]"
                style={{ color: "var(--content-tertiary)" }}
              >
                {formatBucketLabel(bucket)}
              </span>
            </div>
          ))}
        </div>
        {visibleLegendItems.length > 0 ? (
          <UsageSeriesLegendDisplay items={visibleLegendItems} />
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
  hasLegendOverride,
  onSegmentHover,
  onSegmentLeave,
}: {
  bucket: UsageSeriesBucket;
  height: number;
  legendItems: UsageTrendChartLegendItem[];
  hasLegendOverride: boolean;
  onSegmentHover: (
    event: MouseEvent<HTMLElement>,
    content: SegmentTooltipContent,
  ) => void;
  onSegmentLeave: () => void;
}) {
  const hasGroupedData = Object.keys(bucket.groups).length > 0;
  const activeLegendItems = legendItems.filter(
    (item) => (item.state ?? "active") === "active",
  );
  const nonEmptyGroups = activeLegendItems.flatMap((item) => {
    const value = bucket.groups[item.seriesKey];
    if (!value || value.totalEstimatedCostUsd <= 0) {
      return [];
    }
    return [{ item, value }];
  });

  if (nonEmptyGroups.length === 0 && !hasGroupedData && !hasLegendOverride) {
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
  if (nonEmptyGroups.length === 0) {
    return null;
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
            data-usage-series-color-index={item.colorIndex}
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

function UsageSeriesLegendDisplay({
  items,
}: {
  items: UsageTrendChartLegendItem[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1">
      {items.map((item) => {
        const state = item.state ?? "active";
        const isInactive = state === "inactive";
        return (
          <div
            key={item.seriesKey}
            className="flex min-w-0 items-center gap-1"
            data-usage-legend-state={state}
          >
            <span
              className="h-[7px] w-[7px] shrink-0 rounded-full"
              style={{
                background: isInactive
                  ? "var(--content-tertiary)"
                  : colorForIndex(item.colorIndex),
                opacity: isInactive ? 0.45 : 1,
              }}
              aria-hidden="true"
              data-usage-series-color-index={item.colorIndex}
            />
            <span
              className={
                isInactive
                  ? "truncate text-[10px] line-through"
                  : "truncate text-[10px]"
              }
              style={{
                color: "var(--content-tertiary)",
                opacity: isInactive ? 0.65 : 1,
              }}
            >
              {item.label}
            </span>
          </div>
        );
      })}
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
    <div
      className="flex flex-col items-center justify-center rounded-md py-12 text-center"
      style={{ color: "var(--content-tertiary)" }}
    >
      <p
        className="text-body-medium-default"
        style={{ color: "var(--content-secondary)" }}
      >
        {title}
      </p>
      <p className="mt-1 text-body-small-default">{subtitle}</p>
    </div>
  );
}
