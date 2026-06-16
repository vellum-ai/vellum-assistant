import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import {
  consolidationConfigGetOptions,
  consolidationRunsGetOptions,
  heartbeatConfigGetOptions,
  heartbeatConfigGetSetQueryData,
  heartbeatRunsGetOptions,
  retrospectiveConfigGetOptions,
  retrospectiveRunsGetOptions,
  useConsolidationRunnowPostMutation,
  useHeartbeatConfigPutMutation,
  useHeartbeatRunnowPostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import {
  selectConsolidationRuns,
  selectHeartbeatRuns,
  selectRetrospectiveRuns,
} from "@/domains/settings/utils/system-task-run-transforms";
import {
  type ScheduleRowUsage,
  SYSTEM_TASK_STATS_RUN_LIMIT,
  SYSTEM_TASK_URL_IDS,
  summarizeRunsForUsage,
} from "@/domains/settings/utils/schedule-formatters";
import { resolveScheduleUsageWindow } from "@/domains/settings/utils/schedule-usage-window";
import { captureError } from "@/lib/sentry/capture-error";
import { toast } from "@vellumai/design-library/components/toast";

import type { SystemTaskKind } from "@/domains/settings/types/schedules";

const STALE_TIME = 10_000;

/**
 * Composes all TanStack Query state + mutations for system tasks (heartbeat,
 * consolidation, memory retrospective). Uses generated SDK options for both
 * query keys and query functions — no custom fetch wrappers or hand-rolled keys.
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
  } = useQuery({
    ...heartbeatRunsGetOptions(statsOpts),
    select: selectHeartbeatRuns,
    enabled: Boolean(assistantId) && heartbeatConfig != null,
    staleTime: STALE_TIME,
  });

  const {
    data: consolidationRunsForStats,
    isLoading: isConsolidationStatsLoading,
    isError: isConsolidationStatsError,
  } = useQuery({
    ...consolidationRunsGetOptions(statsOpts),
    select: selectConsolidationRuns,
    enabled: Boolean(assistantId) && consolidationConfig?.available === true,
    staleTime: STALE_TIME,
  });

  const {
    data: retrospectiveRunsForStats,
    isLoading: isRetrospectiveStatsLoading,
    isError: isRetrospectiveStatsError,
  } = useQuery({
    ...retrospectiveRunsGetOptions(statsOpts),
    select: selectRetrospectiveRuns,
    enabled: Boolean(assistantId) && retrospectiveConfig?.available === true,
    staleTime: STALE_TIME,
  });

  // ---------------------------------------------------------------------------
  // Derived usage stats
  // ---------------------------------------------------------------------------

  const systemStatsRange = useMemo(
    () => resolveScheduleUsageWindow(tz),
    [tz],
  );

  const heartbeatUsage: ScheduleRowUsage = useMemo(() => {
    if (isHeartbeatStatsLoading) return { status: "loading" };
    if (isHeartbeatStatsError) return { status: "error" };
    return {
      status: "ready",
      summary: summarizeRunsForUsage(
        SYSTEM_TASK_URL_IDS.heartbeat,
        heartbeatRunsForStats,
        systemStatsRange,
      ),
    };
  }, [
    heartbeatRunsForStats,
    isHeartbeatStatsError,
    isHeartbeatStatsLoading,
    systemStatsRange,
  ]);

  const consolidationUsage: ScheduleRowUsage = useMemo(() => {
    if (isConsolidationStatsLoading) return { status: "loading" };
    if (isConsolidationStatsError) return { status: "error" };
    return {
      status: "ready",
      summary: summarizeRunsForUsage(
        SYSTEM_TASK_URL_IDS.consolidation,
        consolidationRunsForStats,
        systemStatsRange,
      ),
    };
  }, [
    consolidationRunsForStats,
    isConsolidationStatsError,
    isConsolidationStatsLoading,
    systemStatsRange,
  ]);

  const retrospectiveUsage: ScheduleRowUsage = useMemo(() => {
    if (isRetrospectiveStatsLoading) return { status: "loading" };
    if (isRetrospectiveStatsError) return { status: "error" };
    return {
      status: "ready",
      summary: summarizeRunsForUsage(
        SYSTEM_TASK_URL_IDS.retrospective,
        retrospectiveRunsForStats,
        systemStatsRange,
      ),
    };
  }, [
    retrospectiveRunsForStats,
    isRetrospectiveStatsError,
    isRetrospectiveStatsLoading,
    systemStatsRange,
  ]);

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  const invalidateSystemTaskQueries = (kind: SystemTaskKind) => {
    if (!assistantId) return;
    const configKey =
      kind === "heartbeat"
        ? heartbeatConfigGetOptions(pathOpts).queryKey
        : kind === "consolidation"
          ? consolidationConfigGetOptions(pathOpts).queryKey
          : retrospectiveConfigGetOptions(pathOpts).queryKey;
    const runsKey =
      kind === "heartbeat"
        ? heartbeatRunsGetOptions(statsOpts).queryKey
        : kind === "consolidation"
          ? consolidationRunsGetOptions(statsOpts).queryKey
          : retrospectiveRunsGetOptions(statsOpts).queryKey;
    void queryClient.invalidateQueries({ queryKey: configKey });
    void queryClient.invalidateQueries({ queryKey: runsKey });
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

  const handleRunNow = (kind: SystemTaskKind) => {
    if (!assistantId) return;
    if (kind === "heartbeat") {
      heartbeatRunNow.mutate({ path: { assistant_id: assistantId } });
    } else if (kind === "consolidation") {
      consolidationRunNow.mutate({ path: { assistant_id: assistantId } });
    }
    // Retrospectives are event-driven per conversation — no run-now exists.
  };

  const handleToggle = (kind: SystemTaskKind, enabled: boolean) => {
    if (!assistantId || kind !== "heartbeat") return;
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
    handleRunNow,
    handleToggle,
    refetchAll,
  };
}
