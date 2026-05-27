import { useQuery } from "@tanstack/react-query";

import type { DateRange } from "@/components/charts/date-range-select";
import { toLocalDateString } from "@/components/charts/format-date-label";
import {
  organizationsBillingUsageSeriesRetrieveOptions,
  organizationsBillingUsageTotalsRetrieveOptions,
} from "@/generated/api/@tanstack/react-query.gen";
import type {
  OrganizationsBillingUsageSeriesRetrieveData,
  OrganizationsBillingUsageTotalsRetrieveData,
} from "@/generated/api/types.gen";
import { getBrowserTimezone } from "@/utils/browser-timezone";
import {
  DEFAULT_LLM_USAGE_DIMENSION,
  type LlmUsageDimension,
  toBillingGroupBy,
} from "@/utils/llm-dimension";

export function getDefaultDateRange(): DateRange {
  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() - 29);
  return {
    from: toLocalDateString(from),
    to: toLocalDateString(today),
  };
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
  tz: string = getBrowserTimezone(),
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
  tz: string = getBrowserTimezone(),
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
  const seriesQuery = useQuery(
    organizationsBillingUsageSeriesRetrieveOptions({
      query: buildBillingUsageSeriesQuery(state),
    }),
  );

  const totalsQuery = useQuery(
    organizationsBillingUsageTotalsRetrieveOptions({
      query: buildBillingUsageTotalsQuery(state),
    }),
  );

  return {
    series: seriesQuery.data,
    totals: totalsQuery.data,
    isLoading: seriesQuery.isLoading || totalsQuery.isLoading,
    isError: seriesQuery.isError || totalsQuery.isError,
  };
}
