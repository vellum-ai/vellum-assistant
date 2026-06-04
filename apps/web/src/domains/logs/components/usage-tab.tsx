import { AlertTriangle, Sparkles, Wand2, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { Dropdown } from "@vellum/design-library";

import { storePendingInitialMessage } from "@/utils/initial-message-launch";
import { routes } from "@/utils/routes";
import { formatCost, formatTokens } from "@/domains/logs/format";
import { useEffectiveTimezone } from "@/utils/use-effective-timezone";
import {
  buildCallSiteMetadataMap,
  fetchUsageCallSiteCatalog,
} from "@/domains/logs/call-site-metadata";
import { decorateUsageBreakdownGroups } from "@/domains/logs/group-labels";
import { fetchUsageProfileMetadata } from "@/domains/logs/profile-metadata";
import { assistantSchedulesQueryKey } from "@/lib/sync/query-tags";
import { fetchSchedules, type AssistantSchedule } from "@/utils/schedules";
import type {
  UsageBreakdownResponse,
  UsageGroupBreakdown,
  UsageGroupBy,
  UsageTimeRange,
  UsageTotals,
} from "@/domains/logs/usage-types";
import {
  fetchUsageBreakdown,
  fetchUsageDaily,
  fetchUsageSeries,
  fetchUsageTotals,
} from "@/domains/logs/usage-api";
import {
  formatBreakdownTokens,
  formatBreakdownTokensShort,
} from "@/domains/logs/usage-breakdown-format";
import {
  decorateUsageSeriesGroups,
  seriesFromDailyBuckets,
} from "@/domains/logs/usage-series";
import {
  buildUsageSearchParams,
  FALLBACK_USAGE_GROUP_BY,
  readUsageUrlState,
  resolveEffectiveUsageGranularity,
  resolveRangeWindow,
  resolveUsageGranularity,
  shouldFallbackUsageGroupBy,
  shouldFetchUsageSeries,
  shouldRetryUsageGroupQuery,
  trendTitle,
  type UsageSearchParamsUpdate,
  USAGE_GROUP_BY_OPTIONS,
} from "@/domains/logs/usage-tab-state";
import {
  UsageTrendChart,
  UsageTrendSkeleton,
} from "@/domains/logs/components/usage-trend-chart";

interface UsageTabProps {
  assistantId: string;
}

type UsageBreakdownState = {
  groupBy: UsageGroupBy;
  response: UsageBreakdownResponse;
};

const RANGE_OPTIONS: { value: UsageTimeRange; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "all", label: "All time" },
];

const ALL_USAGE_FILTER_VALUE = "";
const PROFILE_METADATA_STALE_TIME_MS = 5 * 60 * 1000;
const COST_ANALYSIS_PROMPT = [
  "Please load the llm-cost-optimizer skill.",
  "Analyze my recent LLM usage and explain the biggest cost contributors by call site, model, and profile.",
  "Check my current llm.default, llm.callSites, and llm.profiles.",
  "Give me a concise summary of what is driving cost and what you would optimize first.",
  "Do not change config yet.",
].join(" ");
const COST_OPTIMIZATION_PROMPT = [
  "Please load the llm-cost-optimizer skill.",
  "Analyze my recent LLM usage and current LLM config, then recommend the safest cost-optimization changes.",
  "If changes are clearly safe, show me the exact config commands you would run and ask for confirmation before applying them.",
].join(" ");

export function UsageTab({ assistantId }: UsageTabProps) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { range, groupBy, scheduleId } = useMemo(
    () => readUsageUrlState(searchParams),
    [searchParams],
  );
  const timezone = useEffectiveTimezone();
  const updateUsageSearchParams = useCallback(
    (update: UsageSearchParamsUpdate) => {
      setSearchParams(
        (prev) => buildUsageSearchParams(prev, update),
        { replace: true },
      );
    },
    [setSearchParams],
  );
  // Depend on `timezone` so bounded ranges (e.g. "Today", "Last 7 days")
  // recompute their from/to boundaries in the effective zone when it changes
  // (OS or `device:timezone` update). `resolveRangeWindow` derives the calendar
  // day boundaries in `timezone`, keeping them aligned with the `tz` sent to
  // the backend rather than browser-local boundaries.
  const rangeWindow = useMemo(
    () => resolveRangeWindow(range, timezone),
    [range, timezone],
  );
  const granularity = useMemo(() => resolveUsageGranularity(range), [range]);

  const schedulesQuery = useQuery({
    queryKey: assistantSchedulesQueryKey(assistantId),
    queryFn: () => fetchSchedules(assistantId),
    staleTime: 10_000,
  });

  const startCostConversation = (message: string) => {
    storePendingInitialMessage(message);
    void navigate(routes.assistant);
  };

  const handleRangeChange = useCallback(
    (nextRange: UsageTimeRange) => {
      updateUsageSearchParams({ range: nextRange });
    },
    [updateUsageSearchParams],
  );

  const handleScheduleFilterChange = useCallback(
    (nextScheduleId: string | null) => {
      updateUsageSearchParams({ scheduleId: nextScheduleId });
    },
    [updateUsageSearchParams],
  );

  const handleClearScheduleFilter = useCallback(() => {
    updateUsageSearchParams({ scheduleId: null });
  }, [updateUsageSearchParams]);

  const totalsQuery = useQuery({
    queryKey: [
      "usage-totals",
      assistantId,
      rangeWindow.from,
      rangeWindow.to,
      scheduleId ?? null,
    ],
    queryFn: () =>
      fetchUsageTotals(assistantId, {
        from: rangeWindow.from,
        to: rangeWindow.to,
        scheduleId,
      }),
  });

  const breakdownQuery = useQuery<UsageBreakdownState>({
    queryKey: [
      "usage-breakdown",
      assistantId,
      rangeWindow.from,
      rangeWindow.to,
      groupBy,
      scheduleId ?? null,
    ],
    queryFn: async () => {
      try {
        return {
          groupBy,
          response: await fetchUsageBreakdown(assistantId, {
            from: rangeWindow.from,
            to: rangeWindow.to,
            groupBy,
            scheduleId,
          }),
        };
      } catch (error) {
        if (!shouldFallbackUsageGroupBy(groupBy, error)) {
          throw error;
        }

        return {
          groupBy: FALLBACK_USAGE_GROUP_BY,
          response: await fetchUsageBreakdown(assistantId, {
            from: rangeWindow.from,
            to: rangeWindow.to,
            groupBy: FALLBACK_USAGE_GROUP_BY,
            scheduleId,
          }),
        };
      }
    },
    retry: shouldRetryUsageGroupQuery,
  });

  const effectiveGroupBy = breakdownQuery.data?.groupBy ?? groupBy;
  const seriesGroupBy = shouldFetchUsageSeries(effectiveGroupBy)
    ? effectiveGroupBy
    : undefined;

  const seriesQuery = useQuery({
    queryKey: [
      "usage-series",
      assistantId,
      rangeWindow.from,
      rangeWindow.to,
      granularity,
      timezone,
      effectiveGroupBy,
      scheduleId ?? null,
    ],
    queryFn: () => {
      if (!seriesGroupBy) {
        return { buckets: [] };
      }

      return fetchUsageSeries(assistantId, {
        from: rangeWindow.from,
        to: rangeWindow.to,
        granularity,
        groupBy: seriesGroupBy,
        tz: timezone,
        scheduleId,
      });
    },
    enabled: Boolean(seriesGroupBy),
    retry: shouldRetryUsageGroupQuery,
  });

  const dailyQuery = useQuery({
    queryKey: [
      "usage-daily",
      assistantId,
      rangeWindow.from,
      rangeWindow.to,
      granularity,
      timezone,
      scheduleId ?? null,
    ],
    queryFn: () =>
      fetchUsageDaily(assistantId, {
        from: rangeWindow.from,
        to: rangeWindow.to,
        granularity,
        tz: timezone,
        scheduleId,
      }),
    enabled: !seriesGroupBy || seriesQuery.isError,
  });

  const callSiteCatalogQuery = useQuery({
    queryKey: ["usage-call-sites", assistantId],
    queryFn: () => fetchUsageCallSiteCatalog(assistantId),
    enabled: effectiveGroupBy === "task",
    staleTime: Infinity,
  });

  const profileMetadataQuery = useQuery({
    queryKey: ["usage-profile-metadata", assistantId],
    queryFn: () => fetchUsageProfileMetadata(assistantId),
    enabled: effectiveGroupBy === "profile",
    staleTime: PROFILE_METADATA_STALE_TIME_MS,
  });

  const usageGroupMetadata = useMemo(
    () => ({
      callSites: buildCallSiteMetadataMap(callSiteCatalogQuery.data),
      profiles: profileMetadataQuery.data ?? {},
    }),
    [callSiteCatalogQuery.data, profileMetadataQuery.data],
  );

  const decoratedBreakdown = useMemo(() => {
    const breakdown = breakdownQuery.data;
    if (!breakdown) {
      return undefined;
    }

    return decorateUsageBreakdownGroups(
      breakdown.response.breakdown,
      breakdown.groupBy,
      usageGroupMetadata,
    );
  }, [breakdownQuery.data, usageGroupMetadata]);

  const decoratedSeriesBuckets = useMemo(() => {
    if (!seriesGroupBy || !seriesQuery.data) {
      return undefined;
    }

    return decorateUsageSeriesGroups(
      seriesQuery.data.buckets,
      seriesGroupBy,
      usageGroupMetadata,
    );
  }, [seriesQuery.data, seriesGroupBy, usageGroupMetadata]);

  const dailyFallbackSeriesBuckets = useMemo(() => {
    if (!dailyQuery.data) {
      return undefined;
    }

    return seriesFromDailyBuckets(dailyQuery.data.buckets);
  }, [dailyQuery.data]);

  const trendQuery = useMemo(() => {
    if (!seriesGroupBy) {
      return {
        isLoading: dailyQuery.isLoading,
        error: dailyQuery.error,
        data: dailyFallbackSeriesBuckets,
        refetch: dailyQuery.refetch,
      };
    }

    if (seriesQuery.error) {
      if (dailyFallbackSeriesBuckets) {
        return {
          isLoading: false,
          error: null,
          data: dailyFallbackSeriesBuckets,
          refetch: dailyQuery.refetch,
        };
      }

      return {
        isLoading:
          dailyQuery.isLoading ||
          (!dailyFallbackSeriesBuckets && !dailyQuery.error),
        error: dailyQuery.error ?? seriesQuery.error,
        data: undefined,
        refetch: dailyQuery.error ? dailyQuery.refetch : seriesQuery.refetch,
      };
    }

    return {
      isLoading: seriesQuery.isLoading,
      error: seriesQuery.error,
      data: decoratedSeriesBuckets,
      refetch: seriesQuery.refetch,
    };
  }, [
    dailyFallbackSeriesBuckets,
    dailyQuery.error,
    dailyQuery.isLoading,
    dailyQuery.refetch,
    decoratedSeriesBuckets,
    seriesGroupBy,
    seriesQuery.error,
    seriesQuery.isLoading,
    seriesQuery.refetch,
  ]);

  const effectiveGranularity = resolveEffectiveUsageGranularity({
    requestedGranularity: granularity,
    isLoading: trendQuery.isLoading,
    buckets: trendQuery.data,
  });
  const isHourly = effectiveGranularity === "hourly";
  const trendGroupBy =
    seriesGroupBy && seriesQuery.error ? undefined : effectiveGroupBy;

  const handleGroupByChange = (nextGroupBy: UsageGroupBy) => {
    if (nextGroupBy === groupBy && effectiveGroupBy !== groupBy) {
      void breakdownQuery.refetch();
      void seriesQuery.refetch();
    }
    updateUsageSearchParams({ groupBy: nextGroupBy });
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3
          className="text-title-small"
          style={{ color: "var(--content-default)" }}
        >
          Usage
        </h3>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <ScheduleFilterPicker
            scheduleId={scheduleId}
            schedules={schedulesQuery.data}
            onChange={handleScheduleFilterChange}
            onClear={handleClearScheduleFilter}
          />
          <TimeRangeStrip range={range} onChange={handleRangeChange} />
        </div>
      </div>

      <section aria-label="Totals">
        <QueryState
          query={totalsQuery}
          skeleton={<TotalsSkeleton />}
          render={(totals) => <TotalsGrid totals={totals} />}
        />
      </section>

      <Section title="Inference Usage">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h4
              className="text-body-medium-default"
              style={{ color: "var(--content-default)" }}
            >
              {trendTitle(effectiveGranularity, trendGroupBy)}
            </h4>
            <GroupByPicker
              value={effectiveGroupBy}
              onChange={handleGroupByChange}
            />
          </div>
          <QueryState
            query={trendQuery}
            skeleton={<UsageTrendSkeleton isHourly={isHourly} />}
            render={(buckets) => (
              <UsageTrendChart buckets={buckets} isHourly={isHourly} />
            )}
          />
        </div>
      </Section>

      <BreakdownSection
        query={breakdownQuery}
        groups={decoratedBreakdown}
      />

      <CostAssistantSection
        onAnalyze={() => startCostConversation(COST_ANALYSIS_PROMPT)}
        onOptimize={() => startCostConversation(COST_OPTIMIZATION_PROMPT)}
      />
    </div>
  );
}

function ScheduleFilterPicker({
  scheduleId,
  schedules,
  onChange,
  onClear,
}: {
  scheduleId: string | undefined;
  schedules: AssistantSchedule[] | undefined;
  onChange: (scheduleId: string | null) => void;
  onClear: () => void;
}) {
  const options = useMemo(
    () => buildScheduleFilterOptions(schedules, scheduleId),
    [schedules, scheduleId],
  );

  return (
    <div className="flex items-center gap-1">
      <Dropdown<string>
        value={scheduleId ?? ALL_USAGE_FILTER_VALUE}
        onChange={(value) =>
          onChange(value === ALL_USAGE_FILTER_VALUE ? null : value)
        }
        options={options}
        className="w-44"
        menuMinWidth={220}
        aria-label="Schedule usage filter"
      />
      {scheduleId ? (
        <button
          type="button"
          onClick={onClear}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md border transition-colors"
          style={{
            borderColor: "var(--border-base)",
            color: "var(--content-secondary)",
            background: "transparent",
          }}
          aria-label="Clear schedule filter"
          title="Clear schedule filter"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

function buildScheduleFilterOptions(
  schedules: readonly Pick<AssistantSchedule, "id" | "name">[] | undefined,
  selectedScheduleId: string | undefined,
): Array<{ value: string; label: string }> {
  const options: Array<{ value: string; label: string }> = [
    { value: ALL_USAGE_FILTER_VALUE, label: "All usage" },
  ];
  const knownScheduleIds = new Set<string>();

  for (const schedule of schedules ?? []) {
    knownScheduleIds.add(schedule.id);
  }

  if (selectedScheduleId && !knownScheduleIds.has(selectedScheduleId)) {
    options.push({
      value: selectedScheduleId,
      label: unknownScheduleLabel(selectedScheduleId),
    });
  }

  for (const schedule of schedules ?? []) {
    options.push({
      value: schedule.id,
      label: schedule.name || schedule.id,
    });
  }

  return options;
}

function unknownScheduleLabel(scheduleId: string) {
  return `Unknown schedule (${scheduleId})`;
}

function CostAssistantSection({
  onAnalyze,
  onOptimize,
}: {
  onAnalyze: () => void;
  onOptimize: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div
        className="h-px w-full"
        style={{
          background:
            "linear-gradient(to right, transparent, var(--border-base), transparent)",
        }}
      />
      <Section
        title="Cost assistant"
        subtitle="Review recent spend and tune model profile choices."
      >
        <div
          className="flex flex-col gap-2 rounded-md px-3 py-3 sm:flex-row sm:items-center"
          style={{
            background:
              "color-mix(in srgb, var(--border-base) 15%, transparent)",
          }}
        >
          <button
            type="button"
            onClick={onAnalyze}
            className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-body-medium-default transition-colors"
            style={{
              borderColor: "var(--border-element)",
              color: "var(--content-default)",
              background: "var(--surface-lift)",
            }}
          >
            <Sparkles className="h-4 w-4" />
            Analyze costs with assistant
          </button>
          <button
            type="button"
            onClick={onOptimize}
            className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-body-medium-default transition-colors"
            style={{
              borderColor: "var(--border-base)",
              color: "var(--content-secondary)",
              background: "transparent",
            }}
          >
            <Wand2 className="h-4 w-4" />
            Optimize settings
          </button>
        </div>
      </Section>
    </div>
  );
}

function TimeRangeStrip({
  range,
  onChange,
}: {
  range: UsageTimeRange;
  onChange: (range: UsageTimeRange) => void;
}) {
  return (
    <div className="flex items-center">
      <Dropdown<UsageTimeRange>
        value={range}
        onChange={onChange}
        options={RANGE_OPTIONS.map((option) => ({
          value: option.value,
          label: option.label,
        }))}
      />
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <section
      className="flex flex-col gap-3 rounded-md border px-4 py-4"
      style={{
        background: "var(--surface-lift)",
        borderColor: "var(--border-base)",
      }}
    >
      <div className="flex flex-col gap-1">
        <h3
          className="text-body-medium-default"
          style={{ color: "var(--content-default)" }}
        >
          {title}
        </h3>
        {subtitle ? (
          <p
            className="text-body-small-default"
            style={{ color: "var(--content-tertiary)" }}
          >
            {subtitle}
          </p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

type QueryStateValue<T> = {
  isLoading: boolean;
  error: unknown;
  data: T | undefined;
  refetch: () => unknown;
};

function QueryState<T>({
  query,
  skeleton,
  render,
}: {
  query: QueryStateValue<T>;
  skeleton: ReactNode;
  render: (data: T) => ReactNode;
}) {
  if (query.isLoading) {
    return <>{skeleton}</>;
  }
  if (query.error) {
    const message =
      query.error instanceof Error
        ? query.error.message
        : "Failed to load usage.";
    return <ErrorRow message={message} onRetry={() => query.refetch()} />;
  }
  if (!query.data) {
    return <>{skeleton}</>;
  }
  return <>{render(query.data)}</>;
}

function TotalsGrid({ totals }: { totals: UsageTotals }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div className="flex flex-col gap-1">
          <span
            style={{
              fontSize: "30px",
              fontWeight: 600,
              lineHeight: 1,
              color: "var(--content-default)",
            }}
          >
            {formatCost(totals.totalEstimatedCostUsd)}
          </span>
          <span
            className="text-body-small-default"
            style={{ color: "var(--content-secondary)" }}
          >
            Cost
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span
            className="text-title-small"
            style={{ color: "var(--content-default)" }}
          >
            {formatTokens(totals.eventCount)}
          </span>
          <span
            className="text-body-small-default"
            style={{ color: "var(--content-secondary)" }}
          >
            LLM Calls
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SecondaryMetric
          label="Direct Input Tokens"
          value={formatTokens(totals.totalInputTokens)}
        />
        <SecondaryMetric
          label="Output Tokens"
          value={formatTokens(totals.totalOutputTokens)}
        />
        <SecondaryMetric
          label="Cache Created"
          value={formatTokens(totals.totalCacheCreationTokens)}
        />
        <SecondaryMetric
          label="Cache Read"
          value={formatTokens(totals.totalCacheReadTokens)}
        />
      </div>
    </div>
  );
}

function SecondaryMetric({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div
      className="flex flex-col gap-1 rounded-md px-3 py-2"
      style={{
        background: "color-mix(in srgb, var(--border-base) 15%, transparent)",
      }}
    >
      <span
        className="text-body-small-default"
        style={{ color: "var(--content-default)" }}
      >
        {value}
      </span>
      <span
        className="text-label-medium-default"
        style={{ color: "var(--content-tertiary)" }}
      >
        {label}
      </span>
    </div>
  );
}

function TotalsSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden="true">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div className="flex flex-col gap-1">
          <SkeletonBone width={140} height={30} />
          <SkeletonBone width={90} height={12} />
        </div>
        <div className="flex flex-col gap-1">
          <SkeletonBone width={60} height={16} />
          <SkeletonBone width={60} height={12} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={index}
            className="flex flex-col gap-1 rounded-md px-3 py-2"
            style={{
              background:
                "color-mix(in srgb, var(--border-base) 15%, transparent)",
            }}
          >
            <SkeletonBone width="50%" height={12} />
            <SkeletonBone width="70%" height={11} />
          </div>
        ))}
      </div>
    </div>
  );
}

function GroupByPicker({
  value,
  onChange,
}: {
  value: UsageGroupBy;
  onChange: (value: UsageGroupBy) => void;
}) {
  return (
    <div className="flex items-center">
      <Dropdown<UsageGroupBy>
        value={value}
        onChange={onChange}
        menuAlign="end"
        menuMinWidth={196}
        options={USAGE_GROUP_BY_OPTIONS.map((option) => ({
          value: option.value,
          label: option.label,
        }))}
      />
    </div>
  );
}

type BreakdownOptionalColumn = "pct" | "tokens";

function BreakdownSection({
  query,
  groups: decoratedGroups,
}: {
  query: QueryStateValue<UsageBreakdownState>;
  groups: UsageGroupBreakdown[] | undefined;
}) {
  const [visibleColumns, setVisibleColumns] = useState<
    Set<BreakdownOptionalColumn>
  >(new Set());

  const toggleColumn = (col: BreakdownOptionalColumn) => {
    setVisibleColumns((prev) => {
      const next = new Set(prev);
      if (next.has(col)) {
        next.delete(col);
      } else {
        next.add(col);
      }
      return next;
    });
  };

  return (
    <Section title="Breakdown">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <ColumnToggle
            label="% of total"
            active={visibleColumns.has("pct")}
            onClick={() => toggleColumn("pct")}
          />
          <ColumnToggle
            label="Tokens"
            active={visibleColumns.has("tokens")}
            onClick={() => toggleColumn("tokens")}
          />
        </div>
        <QueryState
          query={query}
          skeleton={<BreakdownSkeleton />}
          render={(breakdown) => (
            <BreakdownTable
              groups={decoratedGroups ?? breakdown.response.breakdown}
              showPct={visibleColumns.has("pct")}
              showTokens={visibleColumns.has("tokens")}
            />
          )}
        />
      </div>
    </Section>
  );
}

function ColumnToggle({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-full border px-2.5 py-1 text-label-medium-default"
      style={{
        borderColor: active
          ? "var(--content-secondary)"
          : "var(--border-base)",
        background: active
          ? "color-mix(in srgb, var(--content-secondary) 15%, transparent)"
          : "transparent",
        color: active ? "var(--content-default)" : "var(--content-tertiary)",
      }}
    >
      {label}
    </button>
  );
}

function BreakdownTable({
  groups,
  showPct,
  showTokens,
}: {
  groups: UsageGroupBreakdown[];
  showPct: boolean;
  showTokens: boolean;
}) {
  if (groups.length === 0) {
    return (
      <EmptyState
        title="No breakdown data"
        subtitle="No usage recorded for this grouping"
      />
    );
  }

  const totalCost = groups.reduce(
    (sum, g) => sum + g.totalEstimatedCostUsd,
    0,
  );

  return (
    <div className="overflow-hidden rounded-md">
      <table className="w-full table-fixed">
        <thead>
          <tr style={{ borderBottom: "1px solid var(--border-base)" }}>
            <th
              className="px-3 py-2.5 text-left text-label-medium-default"
              style={{ color: "var(--content-tertiary)" }}
            >
              Group
            </th>
            {showTokens ? (
              <th
                className="px-3 py-2.5 text-left text-label-medium-default"
                style={{ color: "var(--content-tertiary)", width: "35%" }}
              >
                Tokens
              </th>
            ) : null}
            {showPct ? (
              <th
                className="px-3 py-2.5 text-right text-label-medium-default"
                style={{ color: "var(--content-tertiary)", width: "64px" }}
              >
                %
              </th>
            ) : null}
            <th
              className="px-3 py-2.5 text-right text-label-medium-default"
              style={{ color: "var(--content-tertiary)", width: "100px" }}
            >
              Cost
            </th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group, index) => {
            const tokenDetail = formatBreakdownTokens(group);
            const tokenShort = formatBreakdownTokensShort(group);
            const costPct =
              totalCost > 0
                ? Math.round(
                    (group.totalEstimatedCostUsd / totalCost) * 100,
                  )
                : 0;
            return (
              <tr
                key={
                  group.groupKey ?? group.groupId ?? `${group.group}-${index}`
                }
                style={{
                  borderTop:
                    index === 0 ? "none" : "1px solid var(--border-base)",
                }}
              >
                <td
                  className="min-w-0 px-3 py-2"
                  style={{ color: "var(--content-default)" }}
                >
                  <span
                    className="block truncate text-body-medium-lighter"
                    title={group.group}
                  >
                    {group.group}
                  </span>
                </td>
                {showTokens ? (
                  <td
                    className="min-w-0 px-3 py-2"
                    style={{ color: "var(--content-secondary)" }}
                  >
                    <span
                      className="block truncate text-body-small-default"
                      title={tokenDetail}
                    >
                      {tokenShort}
                    </span>
                  </td>
                ) : null}
                {showPct ? (
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    <span
                      className="text-body-small-default"
                      style={{ color: "var(--content-tertiary)" }}
                    >
                      {costPct}%
                    </span>
                  </td>
                ) : null}
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  <span
                    className="text-body-medium-lighter"
                    style={{ color: "var(--content-default)" }}
                  >
                    {formatCost(group.totalEstimatedCostUsd)}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function BreakdownSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden="true">
      {Array.from({ length: 4 }).map((_, index) => (
        <div key={index} className="flex items-center gap-3">
          <SkeletonBone width={100} height={14} />
          <SkeletonBone width="60%" height={12} />
          <SkeletonBone width={50} height={14} />
        </div>
      ))}
    </div>
  );
}

function SkeletonBone({
  width,
  height,
}: {
  width: number | string;
  height: number;
}) {
  return (
    <div
      className="rounded-sm"
      style={{
        width: typeof width === "number" ? `${width}px` : width,
        height: `${height}px`,
        background: "color-mix(in srgb, var(--border-base) 40%, transparent)",
      }}
    />
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
    <div className="flex flex-col items-center gap-1 py-8 text-center">
      <span
        className="text-body-medium-default"
        style={{ color: "var(--content-default)" }}
      >
        {title}
      </span>
      <span
        className="text-body-small-default"
        style={{ color: "var(--content-tertiary)" }}
      >
        {subtitle}
      </span>
    </div>
  );
}

function ErrorRow({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 py-2">
      <div className="flex items-start gap-2">
        <AlertTriangle
          className="h-4 w-4 shrink-0"
          style={{ color: "var(--system-negative-strong, #f87171)" }}
        />
        <span
          className="text-body-medium-lighter"
          style={{ color: "var(--content-default)" }}
        >
          {message}
        </span>
      </div>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="self-start rounded-md border px-3 py-1 text-body-small-default"
          style={{
            background: "var(--surface-lift)",
            borderColor: "var(--border-base)",
            color: "var(--content-default)",
          }}
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}
