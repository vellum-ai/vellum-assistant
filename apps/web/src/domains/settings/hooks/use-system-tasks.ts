import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  fetchConsolidationConfig,
  fetchConsolidationRuns,
  fetchHeartbeatConfig,
  fetchHeartbeatRuns,
  fetchRetrospectiveConfig,
  fetchRetrospectiveRuns,
  runConsolidationNow,
  runHeartbeatNow,
  updateHeartbeatConfig,
} from "@/domains/settings/api/schedules";
import {
  heartbeatConfigGetQueryKey,
  heartbeatConfigGetSetQueryData,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { Options } from "@/generated/daemon/sdk.gen";
import type { HeartbeatConfigGetData } from "@/generated/daemon/types.gen";
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

/**
 * Encapsulates all TanStack Query composition + mutation logic for
 * system tasks (heartbeat, consolidation, memory retrospective). Exposes
 * a unified interface that the page orchestrator consumes without managing
 * the queries and callbacks itself. Retrospectives are event-driven, so
 * they have no run-now mutation or toggle.
 */
export function useSystemTasks(assistantId: string | undefined, tz: string) {
  const queryClient = useQueryClient();

  // -------------------------------------------------------------------------
  // Config queries
  // -------------------------------------------------------------------------

  const heartbeatConfigOpts = {
    path: { assistant_id: assistantId ?? "" },
  } as Options<HeartbeatConfigGetData>;

  const {
    data: heartbeatConfig,
    isLoading: isHeartbeatLoading,
    isError: isHeartbeatError,
    refetch: refetchHeartbeat,
  } = useQuery({
    queryKey: heartbeatConfigGetQueryKey(heartbeatConfigOpts),
    queryFn: () => fetchHeartbeatConfig(assistantId!),
    enabled: !!assistantId,
    staleTime: 10_000,
  });

  const {
    data: consolidationConfig,
    isLoading: isConsolidationLoading,
    isError: isConsolidationError,
    refetch: refetchConsolidation,
  } = useQuery({
    queryKey: ["consolidation-config", assistantId],
    queryFn: () => fetchConsolidationConfig(assistantId!),
    enabled: !!assistantId,
    staleTime: 10_000,
  });

  const {
    data: retrospectiveConfig,
    isLoading: isRetrospectiveLoading,
    isError: isRetrospectiveError,
    refetch: refetchRetrospective,
  } = useQuery({
    queryKey: ["retrospective-config", assistantId],
    queryFn: () => fetchRetrospectiveConfig(assistantId!),
    enabled: !!assistantId,
    staleTime: 10_000,
  });

  // -------------------------------------------------------------------------
  // Stats queries (for usage display in list view)
  // -------------------------------------------------------------------------

  const {
    data: heartbeatRunsForStats,
    isLoading: isHeartbeatStatsLoading,
    isError: isHeartbeatStatsError,
    refetch: refetchHeartbeatStats,
  } = useQuery({
    queryKey: [
      "system-task-runs-summary",
      assistantId,
      "heartbeat",
      SYSTEM_TASK_STATS_RUN_LIMIT,
    ],
    queryFn: () =>
      fetchHeartbeatRuns(assistantId!, SYSTEM_TASK_STATS_RUN_LIMIT).then(
        (page) => page.runs,
      ),
    enabled: !!assistantId && heartbeatConfig != null,
    staleTime: 10_000,
  });

  const {
    data: consolidationRunsForStats,
    isLoading: isConsolidationStatsLoading,
    isError: isConsolidationStatsError,
    refetch: refetchConsolidationStats,
  } = useQuery({
    queryKey: [
      "system-task-runs-summary",
      assistantId,
      "consolidation",
      SYSTEM_TASK_STATS_RUN_LIMIT,
    ],
    queryFn: () =>
      fetchConsolidationRuns(assistantId!, SYSTEM_TASK_STATS_RUN_LIMIT).then(
        (page) => page.runs,
      ),
    enabled: !!assistantId && consolidationConfig?.available === true,
    staleTime: 10_000,
  });

  const {
    data: retrospectiveRunsForStats,
    isLoading: isRetrospectiveStatsLoading,
    isError: isRetrospectiveStatsError,
    refetch: refetchRetrospectiveStats,
  } = useQuery({
    queryKey: [
      "system-task-runs-summary",
      assistantId,
      "retrospective",
      SYSTEM_TASK_STATS_RUN_LIMIT,
    ],
    queryFn: () =>
      fetchRetrospectiveRuns(assistantId!, SYSTEM_TASK_STATS_RUN_LIMIT).then(
        (page) => page.runs,
      ),
    enabled: !!assistantId && retrospectiveConfig?.available === true,
    staleTime: 10_000,
  });

  // -------------------------------------------------------------------------
  // Derived usage stats
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // Running state + timeout cleanup
  // -------------------------------------------------------------------------

  const [isHeartbeatRunning, setIsHeartbeatRunning] = useState(false);
  const [isConsolidationRunning, setIsConsolidationRunning] = useState(false);
  const timeoutIdsRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const scheduleDelayedInvalidation = useCallback(
    (kind: SystemTaskKind) => {
      if (!assistantId) return;
      const invalidate = () => {
        void queryClient.invalidateQueries({
          queryKey: ["system-task-runs", assistantId, kind],
        });
      };
      invalidate();
      const t1 = setTimeout(invalidate, 1_000);
      const t2 = setTimeout(invalidate, 5_000);
      timeoutIdsRef.current.push(t1, t2);
    },
    [assistantId, queryClient],
  );

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  const handleRunNow = useCallback(
    async (kind: SystemTaskKind) => {
      if (!assistantId) return;
      // Retrospectives are event-driven per conversation — there is nothing
      // global to trigger, so no run-now exists for that kind.
      if (kind === "retrospective") return;
      const setRunning =
        kind === "heartbeat" ? setIsHeartbeatRunning : setIsConsolidationRunning;
      const runFn = kind === "heartbeat" ? runHeartbeatNow : runConsolidationNow;
      const refetchConfig =
        kind === "heartbeat" ? refetchHeartbeat : refetchConsolidation;
      const refetchStats =
        kind === "heartbeat" ? refetchHeartbeatStats : refetchConsolidationStats;
      const successMsg =
        kind === "heartbeat" ? "Heartbeat started." : "Consolidation queued.";
      const skipMsg =
        kind === "heartbeat"
          ? "Heartbeat skipped."
          : "Consolidation already queued or running.";

      setRunning(true);
      try {
        const result = await runFn(assistantId);
        void refetchConfig();
        scheduleDelayedInvalidation(kind);
        void refetchStats();
        if (result.ran) {
          toast.success(successMsg);
        } else {
          toast.info(skipMsg);
        }
      } catch (error) {
        captureError(error, { context: `${kind}_run_now` });
        toast.error(`Failed to run ${kind}.`);
      } finally {
        setRunning(false);
      }
    },
    [
      assistantId,
      refetchConsolidation,
      refetchConsolidationStats,
      refetchHeartbeat,
      refetchHeartbeatStats,
      scheduleDelayedInvalidation,
    ],
  );

  const handleToggle = useCallback(
    async (kind: SystemTaskKind, enabled: boolean) => {
      if (!assistantId) return;
      if (kind !== "heartbeat") return;
      const label = "Heartbeat";

      try {
        const updated = await updateHeartbeatConfig(assistantId, { enabled });
        heartbeatConfigGetSetQueryData(
          queryClient,
          { path: { assistant_id: assistantId } } as Options<HeartbeatConfigGetData>,
          updated,
        );
        toast.success(enabled ? `${label} enabled.` : `${label} disabled.`);
      } catch (error) {
        captureError(error, { context: `${kind}_toggle` });
        toast.error(`Failed to toggle ${label.toLowerCase()}.`);
      }
    },
    [assistantId, queryClient],
  );

  // -------------------------------------------------------------------------
  // Retry
  // -------------------------------------------------------------------------

  const refetchAll = useCallback(() => {
    void refetchHeartbeat();
    void refetchConsolidation();
    void refetchRetrospective();
    void refetchHeartbeatStats();
    void refetchConsolidationStats();
    void refetchRetrospectiveStats();
  }, [
    refetchConsolidation,
    refetchConsolidationStats,
    refetchHeartbeat,
    refetchHeartbeatStats,
    refetchRetrospective,
    refetchRetrospectiveStats,
  ]);

  // -------------------------------------------------------------------------
  // Cleanup pending timeouts on unmount
  // -------------------------------------------------------------------------

  useEffect(() => {
    const ref = timeoutIdsRef;
    return () => {
      for (const id of ref.current) clearTimeout(id);
      ref.current = [];
    };
  }, []);

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
    isHeartbeatRunning,
    isConsolidationRunning,
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
