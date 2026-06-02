import { useQuery } from "@tanstack/react-query";

import {
  type DateRange,
  DEFAULT_PRESET_DAYS,
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
 * Default date range (the `DEFAULT_PRESET_DAYS` preset), with calendar bounds
 * computed in the effective timezone so they stay aligned with the `tz` sent to
 * the billing backend.
 */
export function getDefaultDateRange(tz: string = getEffectiveTimezone()): DateRange {
  return computeRangeInTimezone(DEFAULT_PRESET_DAYS, tz);
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
