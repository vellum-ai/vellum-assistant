import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  BAR_CHART_PALETTE,
  CHART_AXIS_LINE,
  CHART_AXIS_TICK,
  CHART_GRID_PROPS,
} from "@/components/charts/chart-config";
import { formatDateLabel } from "@/components/charts/format-date-label";
import { StackedBarTooltip } from "@/components/charts/stacked-bar-tooltip";
import type { UsageBucket } from "@/generated/api/types.gen";
import { useIsMobile } from "@/hooks/use-is-mobile";

export type ChartMetric = "spend" | "events";

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

// ---------------------------------------------------------------------------
// Data transformation
// ---------------------------------------------------------------------------

type ChartDatum = Record<string, string | number>;

function transformSeries(buckets: UsageBucket[], metric: ChartMetric) {
  const stackKeySet = new Set<string>();
  const labelMap: Record<string, string> = {};

  for (const bucket of buckets) {
    for (const group of bucket.groups) {
      stackKeySet.add(group.group_key);
      labelMap[group.group_key] = group.group_label;
    }
  }

  const data: ChartDatum[] = buckets.map((bucket) => {
    const entry: ChartDatum = { date: bucket.date };
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

// ---------------------------------------------------------------------------
// Scale helpers
// ---------------------------------------------------------------------------

function linearScale(
  domain: [number, number],
  range: [number, number],
): (v: number) => number {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  return (v: number) => r0 + ((v - d0) / span) * (r1 - r0);
}

function niceMax(values: number[]): number {
  const raw = Math.max(0, ...values);
  if (raw === 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  return Math.ceil(raw / magnitude) * magnitude;
}

function generateTicks(max: number, count: number): number[] {
  if (max === 0) return [0];
  const step = max / count;
  const ticks: number[] = [];
  for (let i = 0; i <= count; i++) {
    ticks.push(step * i);
  }
  return ticks;
}

/** Pick evenly-spaced X label indices that avoid overlap on narrow viewports. */
function pickXTickIndices(
  total: number,
  isMobile: boolean,
): number[] {
  if (total <= 0) return [];
  if (isMobile) {
    if (total <= 3) return Array.from({ length: total }, (_, i) => i);
    return [0, Math.floor(total / 2), total - 1];
  }
  const maxTicks = Math.min(total, 12);
  const step = Math.max(1, Math.ceil(total / maxTicks));
  const indices: number[] = [];
  for (let i = 0; i < total; i += step) indices.push(i);
  if (indices[indices.length - 1] !== total - 1) indices.push(total - 1);
  return indices;
}

// ---------------------------------------------------------------------------
// Tooltip state
// ---------------------------------------------------------------------------

type TooltipState = {
  x: number;
  y: number;
  datumIndex: number;
  hoveredKey: string | null;
};

// ---------------------------------------------------------------------------
// ChartLegend
// ---------------------------------------------------------------------------

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
          <span className="text-[var(--content-quiet)]">
            {labelMap[key] ?? key}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BillingUsageChart
// ---------------------------------------------------------------------------

const CHART_HEIGHT = 350;
const MARGIN = { top: 8, right: 4, bottom: 32, left: 0 };
const BAR_GAP_RATIO = 0.2;
const Y_TICK_COUNT = 5;

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
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { data, stackKeys, labelMap } = useMemo(
    () => transformSeries(buckets, metric),
    [buckets, metric],
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

  const formatAxisTick = useCallback(
    (v: number) => {
      if (metric === "spend") {
        if (isMobile && v >= 1) return `$${Math.round(v).toLocaleString("en-US")}`;
        if (v === 0) return "$0";
        const digits = v < 0.01 ? 4 : v < 1 ? 2 : 0;
        return `$${v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
      }
      return v.toLocaleString("en-US");
    },
    [metric, isMobile],
  );

  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  const yAxisWidth = isMobile ? MOBILE_Y_AXIS_WIDTH : 56;
  const axisTick = isMobile ? MOBILE_AXIS_TICK : CHART_AXIS_TICK;

  // Chart area dimensions
  const plotLeft = MARGIN.left + yAxisWidth;
  const plotWidth = Math.max(0, width - plotLeft - MARGIN.right);
  const plotTop = MARGIN.top;
  const plotHeight = CHART_HEIGHT - MARGIN.top - MARGIN.bottom;

  // Stacked totals for Y domain
  const stackTotals = useMemo(
    () =>
      data.map((d) =>
        stackKeys.reduce((sum, k) => sum + (Number(d[k]) || 0), 0),
      ),
    [data, stackKeys],
  );

  const yMax = useMemo(() => niceMax(stackTotals), [stackTotals]);
  const yTicks = useMemo(() => generateTicks(yMax, Y_TICK_COUNT), [yMax]);
  const yScale = useMemo(
    () => linearScale([0, yMax], [plotTop + plotHeight, plotTop]),
    [yMax, plotTop, plotHeight],
  );

  // Band scale for X
  const barCount = data.length;
  const bandWidth = barCount > 0 ? plotWidth / barCount : 0;
  const barWidth = bandWidth * (1 - BAR_GAP_RATIO);
  const barPadding = (bandWidth - barWidth) / 2;

  const xTickIndices = useMemo(
    () => pickXTickIndices(barCount, isMobile),
    [barCount, isMobile],
  );

  if (stackKeys.length === 0) {
    return (
      <div className="flex h-[350px] items-center justify-center text-body-medium-lighter text-[var(--content-faint)]">
        No usage data for this period
      </div>
    );
  }

  // Build stacked bar segments
  const bars = data.map((d, di) => {
    const x = plotLeft + di * bandWidth + barPadding;
    let cumY = 0;
    const segments = stackKeys.map((key, ki) => {
      const val = Number(d[key]) || 0;
      const y0 = cumY;
      cumY += val;
      const sy = yScale(cumY);
      const sh = yScale(y0) - sy;
      const isLast = ki === stackKeys.length - 1;
      return { key, val, x, y: sy, h: sh, color: getBarColor(key, ki), isLast };
    });
    return { di, x, segments };
  });

  const handleBarMouseMove = (
    e: React.MouseEvent<SVGRectElement>,
    datumIndex: number,
    key: string,
  ) => {
    const svgRect = containerRef.current?.getBoundingClientRect();
    if (!svgRect) return;
    setTooltip({
      x: e.clientX - svgRect.left,
      y: e.clientY - svgRect.top,
      datumIndex,
      hoveredKey: key,
    });
  };

  const handleBarMouseLeave = () => setTooltip(null);

  const handleBarClick = (key: string) => {
    if (onBarClick) onBarClick(key);
  };

  // Tooltip payload (mimics recharts shape for StackedBarTooltip reuse)
  const tooltipPayload = tooltip
    ? stackKeys
        .filter((k) => (Number(data[tooltip.datumIndex]?.[k]) || 0) > 0)
        .map((k) => ({
          dataKey: k,
          value: Number(data[tooltip.datumIndex]?.[k]) || 0,
          payload: tooltip.hoveredKey
            ? { __hoveredKey: tooltip.hoveredKey }
            : {},
        }))
    : [];

  // Constrain tooltip within container bounds
  const tooltipStyle: React.CSSProperties = {
    position: "absolute" as const,
    pointerEvents: "none" as const,
    zIndex: 1,
    maxWidth: "calc(100vw - 32px)",
    left: tooltip ? tooltip.x + 12 : 0,
    top: tooltip ? tooltip.y - 12 : 0,
    transform: "translateY(-100%)",
    visibility: tooltip ? "visible" : "hidden",
  };

  return (
    <div onMouseDown={(e) => e.preventDefault()}>
      <div ref={containerRef} style={{ width: "100%", height: CHART_HEIGHT, position: "relative" }}>
        {width > 0 && (
          <>
            <svg
              width={width}
              height={CHART_HEIGHT}
              style={{ display: "block" }}
            >
              {/* Grid lines */}
              {yTicks.map((t) => (
                <line
                  key={t}
                  x1={plotLeft}
                  x2={plotLeft + plotWidth}
                  y1={yScale(t)}
                  y2={yScale(t)}
                  stroke={CHART_GRID_PROPS.stroke}
                  strokeOpacity={CHART_GRID_PROPS.strokeOpacity}
                  strokeDasharray={CHART_GRID_PROPS.strokeDasharray}
                />
              ))}

              {/* X axis line */}
              <line
                x1={plotLeft}
                x2={plotLeft + plotWidth}
                y1={plotTop + plotHeight}
                y2={plotTop + plotHeight}
                stroke={CHART_AXIS_LINE.stroke}
                strokeOpacity={CHART_AXIS_LINE.strokeOpacity}
              />

              {/* Y axis labels */}
              {yTicks.map((t) => (
                <text
                  key={t}
                  x={plotLeft - 8}
                  y={yScale(t)}
                  textAnchor="end"
                  dominantBaseline="middle"
                  fontSize={axisTick.fontSize}
                  fill={axisTick.fill}
                >
                  {formatAxisTick(t)}
                </text>
              ))}

              {/* X axis labels */}
              {xTickIndices.map((idx) => {
                const d = data[idx];
                if (!d) return null;
                const cx = plotLeft + idx * bandWidth + bandWidth / 2;
                return (
                  <text
                    key={idx}
                    x={cx}
                    y={plotTop + plotHeight + 20}
                    textAnchor="middle"
                    fontSize={axisTick.fontSize}
                    fill={axisTick.fill}
                  >
                    {formatDateLabel(String(d.date))}
                  </text>
                );
              })}

              {/* Bars */}
              {bars.map(({ di, segments }) =>
                segments.map((seg) => {
                  if (seg.h <= 0) return null;
                  const opacity =
                    tooltip?.hoveredKey && tooltip.hoveredKey !== seg.key
                      ? 0.4
                      : 1;
                  return (
                    <rect
                      key={`${di}-${seg.key}`}
                      x={seg.x}
                      y={seg.y}
                      width={barWidth}
                      height={seg.h}
                      fill={seg.color}
                      opacity={opacity}
                      rx={seg.isLast ? 3 : 0}
                      ry={seg.isLast ? 3 : 0}
                      cursor={onBarClick ? "pointer" : undefined}
                      onMouseMove={(e) =>
                        handleBarMouseMove(e, di, seg.key)
                      }
                      onMouseLeave={handleBarMouseLeave}
                      onClick={() => handleBarClick(seg.key)}
                    />
                  );
                }),
              )}
            </svg>

            {/* Tooltip */}
            <div style={tooltipStyle}>
              <StackedBarTooltip
                active={!!tooltip}
                payload={tooltipPayload}
                label={tooltip ? String(data[tooltip.datumIndex]?.date) : ""}
                labelMap={labelMap}
                colorMap={colorMap}
                formatValue={formatValue}
              />
            </div>
          </>
        )}
      </div>
      <ChartLegend stackKeys={stackKeys} labelMap={labelMap} />
    </div>
  );
}
