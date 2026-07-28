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
import {
  type PlatformGateState,
  useActiveAssistantIsPlatformHosted,
  usePlatformGate,
} from "@/hooks/use-platform-gate";
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

/**
 * Whether the organization-scoped platform billing queries may fire.
 *
 * These fetches only make sense when three things hold:
 *   - the active assistant is platform-hosted (`platformHostedOnly` gate is
 *     "full"),
 *   - the platform API is reachable (the default reachability gate is not
 *     "gated" — i.e. the app is not in local mode with
 *     `VELLUM_DISABLE_PLATFORM` set, where `platformFeaturesGate` aborts the
 *     request), and
 *   - the assistant is positively resolved as platform-hosted.
 *
 * The `platformHostedOnly` gate deliberately ignores `VELLUM_DISABLE_PLATFORM`
 * and reports "full" during the lifecycle loading window, so neither of the
 * other two checks is redundant: without the reachability gate a local-mode
 * app driving a platform-hosted assistant with the platform API disabled would
 * fire two doomed requests, and without `isPlatformHosted` a fetch could kick
 * off before hosting is resolved.
 */
export function isBillingUsageDataEnabled(
  platformGate: PlatformGateState,
  reachabilityGate: PlatformGateState,
  isPlatformHosted: boolean,
): boolean {
  return (
    platformGate === "full" && reachabilityGate !== "gated" && isPlatformHosted
  );
}

export function useBillingUsageData(state: UsageChartState) {
  const tz = useEffectiveTimezone();

  const platformGate = usePlatformGate({ platformHostedOnly: true });
  const reachabilityGate = usePlatformGate();
  const isPlatformHosted = useActiveAssistantIsPlatformHosted();
  const enabled = isBillingUsageDataEnabled(
    platformGate,
    reachabilityGate,
    isPlatformHosted,
  );

  const seriesQuery = useQuery({
    ...organizationsBillingUsageSeriesRetrieveOptions({
      query: buildBillingUsageSeriesQuery(state, tz),
    }),
    enabled,
  });

  const totalsQuery = useQuery({
    ...organizationsBillingUsageTotalsRetrieveOptions({
      query: buildBillingUsageTotalsQuery(state, tz),
    }),
    enabled,
  });

  return {
    series: seriesQuery.data,
    totals: totalsQuery.data,
    isLoading: seriesQuery.isLoading || totalsQuery.isLoading,
    isError: seriesQuery.isError || totalsQuery.isError,
  };
}
