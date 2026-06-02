import { useQuery } from "@tanstack/react-query";

import {
  type DateRange,
  PRESET_DAYS,
  computeRangeInTimezone,
} from "@/components/charts/date-range-select";
import {
  organizationsBillingUsageSeriesRetrieveOptions,
  organizationsBillingUsageTotalsRetrieveOptions,
} from "@/generated/api/@tanstack/react-query.gen";
import type {
  OrganizationsBillingUsageSeriesRetrieveData,
  OrganizationsBillingUsageTotalsRetrieveData,
} from "@/generated/api/types.gen";
import { getEffectiveTimezone } from "@/utils/effective-timezone";
import {
  DEFAULT_LLM_USAGE_DIMENSION,
  type LlmUsageDimension,
  toBillingGroupBy,
} from "@/utils/llm-dimension";
import { useEffectiveTimezone } from "@/utils/use-effective-timezone";

/**
 * Default "Last 30 days" range, with calendar bounds computed in the effective
 * timezone so they stay aligned with the `tz` sent to the billing backend.
 */
export function getDefaultDateRange(tz: string = getEffectiveTimezone()): DateRange {
  return computeRangeInTimezone(30, tz);
}

/**
 * Reconcile the active date range against a timezone change.
 *
 * The billing control exposes only relative presets (7/30/90 days), so when the
 * effective timezone shifts we recompute whichever preset the user is currently
 * on for the new timezone. We detect that preset by matching `current` against
 * each preset's bounds computed for the PREVIOUS timezone; on a match we return
 * the same preset recomputed for the NEW timezone. A range matching no preset is
 * left untouched, defensively leaving any untracked/custom range alone, and the
 * same `current` reference is returned whenever the bounds don't change so
 * callers can rely on referential bail-outs.
 */
export function reconcilePresetRange(
  current: DateRange,
  prevTz: string,
  nextTz: string,
): DateRange {
  for (const days of PRESET_DAYS) {
    const prev = computeRangeInTimezone(days, prevTz);
    if (current.from === prev.from && current.to === prev.to) {
      const next = computeRangeInTimezone(days, nextTz);
      return next.from === current.from && next.to === current.to
        ? current
        : next;
    }
  }
  return current;
}

export type UsageChartState = {
  dateRange: DateRange;
  setDateRange: (range: DateRange) => void;
  drilldown: BillingUsageDrilldown | null;
  setDrilldown: (
    d: BillingUsageDrilldown | null,
  ) => void;
};

export type BillingUsageSourceFilter = "runtime_proxy" | "oauth_proxy";
export type BillingUsageDrilldown = {
  usageSource: BillingUsageSourceFilter;
  llmDimension?: LlmUsageDimension;
};

export function getBillingUsageGroupBy(
  drilldown: BillingUsageDrilldown | null,
):
  | NonNullable<OrganizationsBillingUsageSeriesRetrieveData["query"]>["group_by"]
  | undefined {
  if (!drilldown) return undefined;
  if (drilldown.usageSource === "oauth_proxy") return "oauth_provider";

  return toBillingGroupBy(
    drilldown.llmDimension ?? DEFAULT_LLM_USAGE_DIMENSION,
  );
}

export function buildBillingUsageSeriesQuery(
  state: UsageChartState,
  tz: string = getEffectiveTimezone(),
): NonNullable<OrganizationsBillingUsageSeriesRetrieveData["query"]> {
  return {
    from: state.dateRange.from,
    to: state.dateRange.to,
    tz,
    ...(state.drilldown
      ? {
          usage_source: state.drilldown.usageSource,
          group_by: getBillingUsageGroupBy(state.drilldown),
        }
      : {}),
  };
}

export function buildBillingUsageTotalsQuery(
  state: UsageChartState,
  tz: string = getEffectiveTimezone(),
): NonNullable<OrganizationsBillingUsageTotalsRetrieveData["query"]> {
  return {
    from: state.dateRange.from,
    to: state.dateRange.to,
    tz,
    ...(state.drilldown
      ? { usage_source: state.drilldown.usageSource }
      : {}),
  };
}

export function useBillingUsageData(state: UsageChartState) {
  const tz = useEffectiveTimezone();

  const seriesQuery = useQuery(
    organizationsBillingUsageSeriesRetrieveOptions({
      query: buildBillingUsageSeriesQuery(state, tz),
    }),
  );

  const totalsQuery = useQuery(
    organizationsBillingUsageTotalsRetrieveOptions({
      query: buildBillingUsageTotalsQuery(state, tz),
    }),
  );

  return {
    series: seriesQuery.data,
    totals: totalsQuery.data,
    isLoading: seriesQuery.isLoading || totalsQuery.isLoading,
    isError: seriesQuery.isError || totalsQuery.isError,
  };
}
