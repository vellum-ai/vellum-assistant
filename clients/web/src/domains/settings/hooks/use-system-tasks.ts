import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import {
  consolidationConfigGetOptions,
  consolidationRunsGetInfiniteQueryKey,
  consolidationRunsGetOptions,
  heartbeatConfigGetOptions,
  heartbeatConfigGetSetQueryData,
  heartbeatRunsGetInfiniteQueryKey,
  heartbeatRunsGetOptions,
  retrospectiveConfigGetOptions,
  retrospectiveRunsGetInfiniteQueryKey,
  retrospectiveRunsGetOptions,
  useConsolidationRunnowPostMutation,
  useHeartbeatConfigPutMutation,
  useHeartbeatRunnowPostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import {
  consolidationRunsGet,
  heartbeatRunsGet,
  retrospectiveRunsGet,
} from "@/generated/daemon/sdk.gen";
import { fetchSystemTaskRunsForUsage } from "@/domains/settings/utils/system-task-run-transforms";
import {
  type ScheduleRowUsage,
  SYSTEM_TASK_STATS_RUN_LIMIT,
  SYSTEM_TASK_URL_IDS,
  summarizeRunsForUsage,
} from "@/domains/settings/utils/schedule-formatters";
import {
  type ScheduleUsageWindow,
  resolveScheduleUsageWindow,
} from "@/domains/settings/utils/schedule-usage-window";
import { captureError } from "@/lib/sentry/capture-error";
import { toast } from "@vellumai/design-library/components/toast";

import type { ScheduleRun, SystemTaskKind } from "@/domains/settings/types/schedules";

const STALE_TIME = 10_000;

function deriveUsage(
  isLoading: boolean,
  isError: boolean,
  urlId: string,
  runs: ScheduleRun[] | undefined,
  range: ScheduleUsageWindow,
): ScheduleRowUsage {
  if (isLoading) return { status: "loading" };
  if (isError) return { status: "error" };
  return { status: "ready", summary: summarizeRunsForUsage(urlId, runs, range) };
}

/**
 * Composes all TanStack Query state + mutations for system tasks (heartbeat,
 * consolidation, memory retrospective). Generated SDK options provide cache
 * keys; stats queries page through generated SDK calls so usage summaries cover
 * the full window.
 */
export function useSystemTasks(assistantId: string | undefined, tz: string) {
  const queryClient = useQueryClient();
  const pathOpts = { path: { assistant_id: assistantId ?? "" } };

  // ---------------------------------------------------------------------------
  // Config queries
  // ---------------------------------------------------------------------------

  const {
    data: heartbeatConfig,
    isLoading: isHeartbeatLoading,
    isError: isHeartbeatError,
    refetch: refetchHeartbeat,
  } = useQuery({
    ...heartbeatConfigGetOptions(pathOpts),
    enabled: Boolean(assistantId),
    staleTime: STALE_TIME,
  });

  const {
    data: consolidationConfig,
    isLoading: isConsolidationLoading,
    isError: isConsolidationError,
    refetch: refetchConsolidation,
  } = useQuery({
    ...consolidationConfigGetOptions(pathOpts),
    enabled: Boolean(assistantId),
    staleTime: STALE_TIME,
  });

  const {
    data: retrospectiveConfig,
    isLoading: isRetrospectiveLoading,
    isError: isRetrospectiveError,
    refetch: refetchRetrospective,
  } = useQuery({
    ...retrospectiveConfigGetOptions(pathOpts),
    enabled: Boolean(assistantId),
    staleTime: STALE_TIME,
  });

  const systemStatsRange = useMemo(
    () => resolveScheduleUsageWindow(tz),
    [tz],
  );

  // ---------------------------------------------------------------------------
  // Stats queries (recent runs for usage summary in the list view)
  // ---------------------------------------------------------------------------

  const statsOpts = {
    path: { assistant_id: assistantId ?? "" },
    query: { limit: SYSTEM_TASK_STATS_RUN_LIMIT },
  };

  const {
    data: heartbeatRunsForStats,
    isLoading: isHeartbeatStatsLoading,
    isError: isHeartbeatStatsError,
    refetch: refetchHeartbeatStats,
  } = useQuery<ScheduleRun[]>({
    queryKey: heartbeatRunsGetOptions(statsOpts).queryKey,
    queryFn: ({ signal }) =>
      fetchSystemTaskRunsForUsage({
        kind: "heartbeat",
        range: systemStatsRange,
        signal,
        fetchPage: async (before, signal) => {
          const { data } = await heartbeatRunsGet({
            ...statsOpts,
            query:
              before == null
                ? statsOpts.query
                : { ...statsOpts.query, before },
            signal,
            throwOnError: true,
          });
          return data;
        },
      }),
    enabled: Boolean(assistantId) && heartbeatConfig != null,
    staleTime: STALE_TIME,
  });

  const {
    data: consolidationRunsForStats,
    isLoading: isConsolidationStatsLoading,
    isError: isConsolidationStatsError,
    refetch: refetchConsolidationStats,
  } = useQuery<ScheduleRun[]>({
    queryKey: consolidationRunsGetOptions(statsOpts).queryKey,
    queryFn: ({ signal }) =>
      fetchSystemTaskRunsForUsage({
        kind: "consolidation",
        range: systemStatsRange,
        signal,
        fetchPage: async (before, signal) => {
          const { data } = await consolidationRunsGet({
            ...statsOpts,
            query:
              before == null
                ? statsOpts.query
                : { ...statsOpts.query, before },
            signal,
            throwOnError: true,
          });
          return data;
        },
      }),
    enabled: Boolean(assistantId) && consolidationConfig?.available === true,
    staleTime: STALE_TIME,
  });

  const {
    data: retrospectiveRunsForStats,
    isLoading: isRetrospectiveStatsLoading,
    isError: isRetrospectiveStatsError,
    refetch: refetchRetrospectiveStats,
  } = useQuery<ScheduleRun[]>({
    queryKey: retrospectiveRunsGetOptions(statsOpts).queryKey,
    queryFn: ({ signal }) =>
      fetchSystemTaskRunsForUsage({
        kind: "retrospective",
        range: systemStatsRange,
        signal,
        fetchPage: async (before, signal) => {
          const { data } = await retrospectiveRunsGet({
            ...statsOpts,
            query:
              before == null
                ? statsOpts.query
                : { ...statsOpts.query, before },
            signal,
            throwOnError: true,
          });
          return data;
        },
      }),
    enabled: Boolean(assistantId) && retrospectiveConfig?.available === true,
    staleTime: STALE_TIME,
  });

  // ---------------------------------------------------------------------------
  // Derived usage stats
  // ---------------------------------------------------------------------------

  const heartbeatUsage: ScheduleRowUsage = useMemo(
    () => deriveUsage(isHeartbeatStatsLoading, isHeartbeatStatsError, SYSTEM_TASK_URL_IDS.heartbeat, heartbeatRunsForStats, systemStatsRange),
    [heartbeatRunsForStats, isHeartbeatStatsError, isHeartbeatStatsLoading, systemStatsRange],
  );

  const consolidationUsage: ScheduleRowUsage = useMemo(
    () => deriveUsage(isConsolidationStatsLoading, isConsolidationStatsError, SYSTEM_TASK_URL_IDS.consolidation, consolidationRunsForStats, systemStatsRange),
    [consolidationRunsForStats, isConsolidationStatsError, isConsolidationStatsLoading, systemStatsRange],
  );

  const retrospectiveUsage: ScheduleRowUsage = useMemo(
    () => deriveUsage(isRetrospectiveStatsLoading, isRetrospectiveStatsError, SYSTEM_TASK_URL_IDS.retrospective, retrospectiveRunsForStats, systemStatsRange),
    [retrospectiveRunsForStats, isRetrospectiveStatsError, isRetrospectiveStatsLoading, systemStatsRange],
  );

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  const invalidateSystemTaskQueries = (kind: SystemTaskKind) => {
    if (!assistantId) return;
    const keysForKind = {
      heartbeat: {
        config: heartbeatConfigGetOptions(pathOpts).queryKey,
        runs: heartbeatRunsGetOptions(statsOpts).queryKey,
        infinite: heartbeatRunsGetInfiniteQueryKey(pathOpts),
      },
      consolidation: {
        config: consolidationConfigGetOptions(pathOpts).queryKey,
        runs: consolidationRunsGetOptions(statsOpts).queryKey,
        infinite: consolidationRunsGetInfiniteQueryKey(pathOpts),
      },
      retrospective: {
        config: retrospectiveConfigGetOptions(pathOpts).queryKey,
        runs: retrospectiveRunsGetOptions(statsOpts).queryKey,
        infinite: retrospectiveRunsGetInfiniteQueryKey(pathOpts),
      },
    }[kind];
    void queryClient.invalidateQueries({ queryKey: keysForKind.config });
    void queryClient.invalidateQueries({ queryKey: keysForKind.runs });
    void queryClient.invalidateQueries({ queryKey: keysForKind.infinite });
  };

  const heartbeatRunNow = useHeartbeatRunnowPostMutation({
    onSuccess: (data) => {
      if (data.ran) {
        toast.success("Heartbeat started.");
      } else {
        toast.info("Heartbeat skipped.");
      }
    },
    onError: (error) => {
      captureError(error, { context: "heartbeat_run_now" });
      toast.error("Failed to run heartbeat.");
    },
    onSettled: () => invalidateSystemTaskQueries("heartbeat"),
  });

  const consolidationRunNow = useConsolidationRunnowPostMutation({
    onSuccess: (data) => {
      if (data.ran) {
        toast.success("Consolidation queued.");
      } else {
        toast.info("Consolidation already queued or running.");
      }
    },
    onError: (error) => {
      captureError(error, { context: "consolidation_run_now" });
      toast.error("Failed to run consolidation.");
    },
    onSettled: () => invalidateSystemTaskQueries("consolidation"),
  });

  const heartbeatToggle = useHeartbeatConfigPutMutation({
    onSuccess: (data) => {
      heartbeatConfigGetSetQueryData(queryClient, pathOpts, data);
      toast.success(data.enabled ? "Heartbeat enabled." : "Heartbeat disabled.");
    },
    onError: (error) => {
      captureError(error, { context: "heartbeat_toggle" });
      toast.error("Failed to toggle heartbeat.");
    },
  });

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const runHeartbeatNow = () => {
    if (!assistantId) return;
    heartbeatRunNow.mutate({ path: { assistant_id: assistantId } });
  };

  const runConsolidationNow = () => {
    if (!assistantId) return;
    consolidationRunNow.mutate({ path: { assistant_id: assistantId } });
  };

  const toggleHeartbeat = (enabled: boolean) => {
    if (!assistantId) return;
    heartbeatToggle.mutate({
      body: { enabled },
      path: { assistant_id: assistantId },
    });
  };

  // ---------------------------------------------------------------------------
  // Retry
  // ---------------------------------------------------------------------------

  const refetchAll = () => {
    void refetchHeartbeat();
    void refetchConsolidation();
    void refetchRetrospective();
    void refetchHeartbeatStats();
    void refetchConsolidationStats();
    void refetchRetrospectiveStats();
  };

  return {
    heartbeatConfig,
    consolidationConfig,
    retrospectiveConfig,
    heartbeatUsage,
    consolidationUsage,
    retrospectiveUsage,
    isLoading:
      isHeartbeatLoading || isConsolidationLoading || isRetrospectiveLoading,
    hasError: isHeartbeatError || isConsolidationError || isRetrospectiveError,
    isHeartbeatRunning: heartbeatRunNow.isPending,
    isConsolidationRunning: consolidationRunNow.isPending,
    isHeartbeatLoading,
    isHeartbeatError,
    isConsolidationLoading,
    isConsolidationError,
    isRetrospectiveLoading,
    isRetrospectiveError,
    refetchHeartbeat,
    refetchConsolidation,
    refetchRetrospective,
    runHeartbeatNow,
    runConsolidationNow,
    toggleHeartbeat,
    refetchAll,
  };
}
