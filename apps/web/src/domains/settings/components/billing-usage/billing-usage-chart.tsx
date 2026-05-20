import { useCallback, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  BAR_CHART_PALETTE,
  CHART_AXIS_LINE,
  CHART_AXIS_TICK,
  CHART_GRID_PROPS,
} from "@/components/charts/chart-config.js";
import { formatDateLabel } from "@/components/charts/format-date-label.js";
import { StackedBarTooltip } from "@/components/charts/stacked-bar-tooltip.js";
import type { UsageBucket } from "@/generated/api/types.gen.js";
import { useIsMobile } from "@/hooks/use-is-mobile.js";

export type ChartMetric = "spend" | "events";

// Mobile tweaks — mirror the pattern `SimpleBarChart` uses so the stacked
// usage chart reads cleanly on a narrow viewport.
//   - `MOBILE_Y_AXIS_WIDTH` shrinks the y-axis gutter so a tick label like
//     `$340` doesn't eat half the chart area.
//   - `MOBILE_AXIS_TICK` drops 12 → 11 px to match the rest of the
//     analytics charts on mobile.
//
// Height is intentionally NOT capped on mobile — the previous 240 cap
// (PR #6252) made trends unreadable. Mobile users scroll fine.
const MOBILE_Y_AXIS_WIDTH = 40;
const MOBILE_AXIS_TICK = { fontSize: 11, fill: "#8d99a5" } as const;

const USAGE_SOURCE_COLORS: Record<string, string> = {
  runtime_proxy_api: "#3b82f6",
  oauth_proxy: "#f59e0b",
};

function getBarColor(key: string, index: number): string {
  return (
    USAGE_SOURCE_COLORS[key] ??
    BAR_CHART_PALETTE[index % BAR_CHART_PALETTE.length] ??
    "#6b7280"
  );
}

function transformSeriesForRecharts(
  buckets: UsageBucket[],
  metric: ChartMetric,
) {
  const stackKeySet = new Set<string>();
  const labelMap: Record<string, string> = {};

  for (const bucket of buckets) {
    for (const group of bucket.groups) {
      stackKeySet.add(group.group_key);
      labelMap[group.group_key] = group.group_label;
    }
  }

  const data = buckets.map((bucket) => {
    const entry: Record<string, string | number> = { date: bucket.date };
    for (const group of bucket.groups) {
      entry[group.group_key] =
        metric === "spend"
          ? parseFloat(group.total_usd)
          : group.event_count;
    }
    return entry;
  });

  return { data, stackKeys: Array.from(stackKeySet), labelMap };
}

function ChartLegend({
  stackKeys,
  labelMap,
}: {
  stackKeys: string[];
  labelMap: Record<string, string>;
}) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1 pt-3 text-body-small-default">
      {stackKeys.map((key, i) => (
        <div key={key} className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-sm"
            style={{ backgroundColor: getBarColor(key, i) }}
          />
          <span className="text-stone-500 dark:text-stone-400">
            {labelMap[key] ?? key}
          </span>
        </div>
      ))}
    </div>
  );
}

export function BillingUsageChart({
  buckets,
  metric,
  onBarClick,
}: {
  buckets: UsageBucket[];
  metric: ChartMetric;
  onBarClick?: (groupKey: string) => void;
}) {
  const isMobile = useIsMobile();

  const { data, stackKeys, labelMap } = useMemo(
    () => transformSeriesForRecharts(buckets, metric),
    [buckets, metric],
  );

  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  const dataWithHover = useMemo(
    () =>
      hoveredKey
        ? data.map((d) => ({ ...d, __hoveredKey: hoveredKey }))
        : data,
    [data, hoveredKey],
  );

  const colorMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (let i = 0; i < stackKeys.length; i++) {
      map[stackKeys[i]!] = getBarColor(stackKeys[i]!, i);
    }
    return map;
  }, [stackKeys]);

  const formatValue = useCallback(
    (v: number) =>
      metric === "spend"
        ? `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : v.toLocaleString("en-US"),
    [metric],
  );

  if (stackKeys.length === 0) {
    return (
      <div className="flex h-[350px] items-center justify-center text-body-medium-lighter text-stone-400 dark:text-stone-500">
        No usage data for this period
      </div>
    );
  }

  // Mobile y-axis tick drops the `.00` cents suffix — Recharts' default
  // `${value}` renders integer ticks as `$340` already, but very small
  // currency values get fractional ticks like `$1.5` that look noisy on a
  // narrow gutter. Tooltip values still use the precise `formatValue` for
  // accuracy on hover.
  const formatAxisTick = (v: number) =>
    metric === "spend"
      ? `$${isMobile ? Math.round(v).toLocaleString("en-US") : v}`
      : v.toLocaleString("en-US");

  const yAxisWidth = isMobile ? MOBILE_Y_AXIS_WIDTH : 56;
  const axisTick = isMobile ? MOBILE_AXIS_TICK : CHART_AXIS_TICK;

  // On mobile, force start/end x-ticks (auto-tick selection routinely
  // renders zero labels at narrow widths) and tighten the gap.
  const xAxisInterval = isMobile ? ("preserveStartEnd" as const) : undefined;
  const xAxisMinTickGap = isMobile ? 8 : 32;

  return (
    <div onMouseDown={(e) => e.preventDefault()}>
      <ResponsiveContainer width="100%" height={350}>
        <BarChart
          data={dataWithHover}
          margin={{ top: 8, right: 4, left: -8, bottom: 0 }}
          barCategoryGap="20%"
        >
          <CartesianGrid {...CHART_GRID_PROPS} />
          <XAxis
            dataKey="date"
            tickFormatter={formatDateLabel}
            tick={axisTick}
            axisLine={CHART_AXIS_LINE}
            tickLine={false}
            dy={8}
            interval={xAxisInterval}
            minTickGap={xAxisMinTickGap}
          />
          <YAxis
            tickFormatter={formatAxisTick}
            tick={axisTick}
            axisLine={false}
            tickLine={false}
            width={yAxisWidth}
          />
          <Tooltip
            cursor={{ fill: "transparent" }}
            // Constrain the tooltip wrapper so the custom dark card never
            // overflows the viewport on mobile (long group labels like
            // "Inference Profile / OAuth Spend" want to wrap).
            wrapperStyle={{
              maxWidth: "calc(100vw - 32px)",
              pointerEvents: "none",
              zIndex: 1,
            }}
            content={
              <StackedBarTooltip
                labelMap={labelMap}
                colorMap={colorMap}
                formatValue={formatValue}
              />
            }
          />
          {stackKeys.map((key, i) => (
            <Bar
              key={key}
              dataKey={key}
              stackId="usage"
              fill={getBarColor(key, i)}
              radius={
                i === stackKeys.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]
              }
              onMouseEnter={() => setHoveredKey(key)}
              onMouseLeave={() => setHoveredKey(null)}
              {...(onBarClick
                ? {
                    cursor: "pointer",
                    activeBar: { fill: getBarColor(key, i) },
                    onClick: () => onBarClick(key),
                  }
                : {})}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
      <ChartLegend stackKeys={stackKeys} labelMap={labelMap} />
    </div>
  );
}
