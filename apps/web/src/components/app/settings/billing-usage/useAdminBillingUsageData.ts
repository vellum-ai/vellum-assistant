import { useQuery } from "@tanstack/react-query";

import type { DateRange } from "@/components/app/charts/DateRangeSelect.js";
import {
  organizationsBillingUsageSeriesRetrieveOptions,
  organizationsBillingUsageTotalsRetrieveOptions,
} from "@/generated/api/@tanstack/react-query.gen.js";
import type {
  OrganizationsBillingUsageSeriesRetrieveData,
  OrganizationsBillingUsageTotalsRetrieveData,
} from "@/generated/api/types.gen.js";
import { getBrowserTimezone } from "@/lib/usage/browser-timezone.js";
import {
  type LlmUsageDimension,
  toBillingGroupBy,
} from "@/lib/usage/llm-dimension.js";

export type AdminSourceFilter = "all" | "llm" | "oauth";

export type AdminUsageFilterState = {
  dateRange: DateRange;
  sourceFilter: AdminSourceFilter;
  llmDimension: LlmUsageDimension;
};

function sourceFilterToUsageSource(
  f: AdminSourceFilter,
): "runtime_proxy" | "oauth_proxy" | undefined {
  switch (f) {
    case "all":
      return undefined;
    case "llm":
      return "runtime_proxy";
    case "oauth":
      return "oauth_proxy";
  }
}

function getGroupBy(
  sourceFilter: AdminSourceFilter,
  llmDimension: LlmUsageDimension,
):
  | NonNullable<
      OrganizationsBillingUsageSeriesRetrieveData["query"]
    >["group_by"]
  | undefined {
  switch (sourceFilter) {
    case "all":
      return undefined;
    case "llm":
      return toBillingGroupBy(llmDimension);
    case "oauth":
      return "oauth_provider";
  }
}

export function buildAdminBillingUsageSeriesQuery(
  organizationId: string,
  state: AdminUsageFilterState,
  tz: string = getBrowserTimezone(),
): NonNullable<OrganizationsBillingUsageSeriesRetrieveData["query"]> {
  const usageSource = sourceFilterToUsageSource(state.sourceFilter);
  const groupBy = getGroupBy(state.sourceFilter, state.llmDimension);
  return {
    from: state.dateRange.from,
    to: state.dateRange.to,
    tz,
    ...(usageSource ? { usage_source: usageSource } : {}),
    ...(groupBy ? { group_by: groupBy } : {}),
  };
}

export function buildAdminBillingUsageTotalsQuery(
  organizationId: string,
  state: AdminUsageFilterState,
  tz: string = getBrowserTimezone(),
): NonNullable<OrganizationsBillingUsageTotalsRetrieveData["query"]> {
  const usageSource = sourceFilterToUsageSource(state.sourceFilter);
  return {
    from: state.dateRange.from,
    to: state.dateRange.to,
    tz,
    ...(usageSource ? { usage_source: usageSource } : {}),
  };
}

export function useAdminBillingUsageData(
  organizationId: string,
  state: AdminUsageFilterState,
) {
  const seriesQuery = useQuery(
    organizationsBillingUsageSeriesRetrieveOptions({
      query: buildAdminBillingUsageSeriesQuery(organizationId, state),
    }),
  );

  const totalsQuery = useQuery(
    organizationsBillingUsageTotalsRetrieveOptions({
      query: buildAdminBillingUsageTotalsQuery(organizationId, state),
    }),
  );

  return {
    series: seriesQuery.data,
    totals: totalsQuery.data,
    isLoading: seriesQuery.isLoading || totalsQuery.isLoading,
    isError: seriesQuery.isError || totalsQuery.isError,
  };
}
