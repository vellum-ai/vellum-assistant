import { useQuery } from "@tanstack/react-query";

import type { DateRange } from "@/components/charts/date-range-select.js";
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

interface AdminBillingUsageQuery {
  organization_id: string;
  from: string;
  to: string;
  tz: string;
  usage_source?: "runtime_proxy" | "oauth_proxy";
  group_by?: string;
}

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
): string | undefined {
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
): AdminBillingUsageQuery {
  const usageSource = sourceFilterToUsageSource(state.sourceFilter);
  const groupBy = getGroupBy(state.sourceFilter, state.llmDimension);
  return {
    organization_id: organizationId,
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
): Omit<AdminBillingUsageQuery, "group_by"> {
  const usageSource = sourceFilterToUsageSource(state.sourceFilter);
  return {
    organization_id: organizationId,
    from: state.dateRange.from,
    to: state.dateRange.to,
    tz,
    ...(usageSource ? { usage_source: usageSource } : {}),
  };
}

/**
 * Admin billing usage data hook. Uses internal admin endpoints that are
 * only available to org admins on the hosted platform. Returns undefined
 * data when the endpoints are unavailable (e.g. OSS/self-hosted).
 */
export function useAdminBillingUsageData(
  organizationId: string,
  state: AdminUsageFilterState,
) {
  const seriesQuery = useQuery({
    queryKey: ["admin-billing-usage-series", organizationId, state],
    queryFn: async () => {
      const query = buildAdminBillingUsageSeriesQuery(organizationId, state);
      const res = await fetch(
        `/admin/api/billing/usage/series?${new URLSearchParams(query as unknown as Record<string, string>)}`,
      );
      if (!res.ok) return null;
      return res.json();
    },
    enabled: false,
  });

  const totalsQuery = useQuery({
    queryKey: ["admin-billing-usage-totals", organizationId, state],
    queryFn: async () => {
      const query = buildAdminBillingUsageTotalsQuery(organizationId, state);
      const res = await fetch(
        `/admin/api/billing/usage/totals?${new URLSearchParams(query as unknown as Record<string, string>)}`,
      );
      if (!res.ok) return null;
      return res.json();
    },
    enabled: false,
  });

  return {
    series: seriesQuery.data,
    totals: totalsQuery.data,
    isLoading: seriesQuery.isLoading || totalsQuery.isLoading,
    isError: seriesQuery.isError || totalsQuery.isError,
  };
}
