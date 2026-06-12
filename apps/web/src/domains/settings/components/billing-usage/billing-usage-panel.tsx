import { useMemo, useState } from "react";

import { ArrowLeft, Coins, Loader2, Target } from "lucide-react";

import { Card } from "@vellumai/design-library/components/card";
import {
    SegmentControl,
    type SegmentControlItem,
} from "@vellumai/design-library/components/segment-control";
import { StatSquare } from "@vellumai/design-library/components/stat-square";
import { Typography } from "@vellumai/design-library/components/typography";

import {
    DEFAULT_PRESET_DAYS,
    type DateRange,
    DateRangeSelect,
    computeRangeInTimezone,
} from "@/components/charts/date-range-select";
import {
    DEFAULT_LLM_USAGE_DIMENSION,
    LLM_USAGE_DIMENSION_ITEMS,
    type LlmUsageDimension,
} from "@/utils/llm-dimension";

import {
  BillingUsageChart,
  type ChartMetric,
} from "@/domains/settings/components/billing-usage/billing-usage-chart";
import {
    type BillingUsageSourceFilter,
    getDefaultDateRange,
    useBillingUsageData,
} from "@/domains/settings/components/billing-usage/use-billing-usage-data";
import { useEffectiveTimezone } from "@/utils/use-effective-timezone";

const METRIC_ITEMS: SegmentControlItem<ChartMetric>[] = [
  { value: "spend", label: "Spend ($)" },
  { value: "events", label: "Events" },
];

/**
 * Format a USD amount string for display (e.g. "12.50" -> "$12.50").
 * Returns "$0.00" for unparseable values.
 */
function formatUsd(value: string | undefined): string {
  if (value === undefined) return "—";
  const num = parseFloat(value);
  if (Number.isNaN(num)) {
    return "$0.00";
  }
  return `$${num.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Format an event count for display with thousands separators. */
function formatEventCount(count: number | undefined): string {
  if (count === undefined) return "—";
  return count.toLocaleString("en-US");
}

export function BillingUsagePanel() {
  const tz = useEffectiveTimezone();
  // Track the SELECTED PRESET IDENTITY (days), not its computed bounds. The
  // active range is derived from this identity + the live tz below, so a tz
  // change (even one that crosses a calendar-day rollover after the range was
  // first computed) always yields the correct bounds for the active preset.
  // `null` means a custom range that isn't a preset (defensive; billing only
  // exposes presets today) — in that case `customRange` holds the bounds.
  const [presetDays, setPresetDays] = useState<number | null>(
    DEFAULT_PRESET_DAYS,
  );
  const [customRange, setCustomRange] = useState<DateRange>(() =>
    getDefaultDateRange(tz),
  );

  const dateRange = useMemo<DateRange>(
    () =>
      presetDays === null ? customRange : computeRangeInTimezone(presetDays, tz),
    [presetDays, customRange, tz],
  );

  const handleRangeChange = (range: DateRange, nextPresetDays: number) => {
    setPresetDays(nextPresetDays);
    setCustomRange(range);
  };

  const [drilldown, setDrilldown] = useState<{
    usageSource: BillingUsageSourceFilter;
    llmDimension?: LlmUsageDimension;
  } | null>(null);
  const [metric, setMetric] = useState<ChartMetric>("spend");

  const { series, totals, isLoading, isError } = useBillingUsageData({
    dateRange,
    // Any imperative range set is treated as custom (not a preset). The data
    // hook only reads `dateRange`, so this exists to satisfy UsageChartState.
    setDateRange: (range) => {
      setPresetDays(null);
      setCustomRange(range);
    },
    drilldown,
    setDrilldown,
  });

  const handleBarClick = drilldown
    ? undefined
    : (groupKey: string) => {
        const usageSourceMap: Record<string, BillingUsageSourceFilter> = {
          runtime_proxy_api: "runtime_proxy",
          oauth_proxy: "oauth_proxy",
        };
        const usageSource = usageSourceMap[groupKey];
        if (usageSource) {
          setDrilldown({
            usageSource,
            ...(usageSource === "runtime_proxy"
              ? { llmDimension: DEFAULT_LLM_USAGE_DIMENSION }
              : {}),
          });
        }
      };

  return (
    <Card padding="md">
      <div className="flex flex-col gap-4">
        {/* Header row: title block (left) + controls (right) */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <Typography
              as="h2"
              variant="title-medium"
              className="text-[var(--content-default)]"
            >
              Credit Usage
            </Typography>
            <Typography
              as="p"
              variant="body-small-default"
              className="mt-2 text-[var(--content-tertiary)]"
            >
              Overview of your spending habits.
            </Typography>
          </div>
          {/*
           * Compact 32px controls per Figma. The shared `Dropdown` and
           * `SegmentControl` primitives don't expose a size prop, so we
           * override the inner button heights with arbitrary descendant
           * variants here rather than mutating the shared primitives.
           * - Dropdown's trigger is `<button role="combobox">` (h-9 → h-8).
           * - SegmentControl's inner items are `<button role="radio">`
           *   wrapped by a 2px-padded container, so h-7 inner = 32px outer.
           */}
          <div className="flex flex-wrap items-center justify-end gap-2 [&_[role=combobox]]:h-8 [&_[role=radio]]:h-7">
            <DateRangeSelect value={dateRange} onChange={handleRangeChange} />
            <div className="w-44">
              <SegmentControl
                items={METRIC_ITEMS}
                value={metric}
                onChange={setMetric}
                ariaLabel="Chart metric"
              />
            </div>
          </div>
        </div>

        {/* Stat squares: total spend + event count */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <StatSquare
            icon={<Coins className="h-4 w-4" aria-hidden />}
            value={
              isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                formatUsd(totals?.total_usd)
              )
            }
            label="Spend"
          />
          <StatSquare
            icon={<Target className="h-4 w-4" aria-hidden />}
            value={
              isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                formatEventCount(totals?.event_count)
              )
            }
            label="Events"
          />
        </div>

        {/* Drilldown breadcrumb + LLM dimension control */}
        {drilldown && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <button
                className="flex items-center gap-1.5 text-body-medium-lighter text-[var(--content-tertiary)] transition-colors hover:text-[var(--content-secondary)]"
                onClick={() => setDrilldown(null)}
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                <span>Back to all usage</span>
                <span className="text-[var(--content-tertiary)]">/</span>
                <span className="text-body-medium-default text-[var(--content-default)]">
                  {drilldown.usageSource === "runtime_proxy"
                    ? "LLM Spend"
                    : "OAuth Spend"}
                </span>
              </button>
            </div>
            {drilldown.usageSource === "runtime_proxy" && (
              <div className="w-56">
                <SegmentControl
                  items={LLM_USAGE_DIMENSION_ITEMS}
                  value={
                    drilldown.llmDimension ?? DEFAULT_LLM_USAGE_DIMENSION
                  }
                  onChange={(nextDimension) =>
                    setDrilldown({
                      usageSource: "runtime_proxy",
                      llmDimension: nextDimension,
                    })
                  }
                  ariaLabel="LLM spend dimension"
                />
              </div>
            )}
          </div>
        )}

        {/* Chart */}
        {isLoading ? (
          <div className="flex h-[345px] items-center justify-center rounded-xl bg-[var(--surface-base)]">
            <Loader2 className="h-6 w-6 animate-spin text-[var(--content-tertiary)]" />
          </div>
        ) : isError ? (
          <div className="flex h-[345px] items-center justify-center rounded-xl bg-[var(--surface-base)] text-body-medium-lighter text-[var(--content-tertiary)]">
            Failed to load usage data.
          </div>
        ) : series ? (
          <div className="rounded-xl bg-[var(--surface-base)] p-3">
              <BillingUsageChart
                buckets={series.buckets}
                metric={metric}
                onBarClick={handleBarClick}
              />
          </div>
        ) : null}
      </div>
    </Card>
  );
}
