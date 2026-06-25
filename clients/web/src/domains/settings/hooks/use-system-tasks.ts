import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import {
  consolidationConfigGetOptions,
  consolidationRunsGetInfiniteQueryKey,
  heartbeatConfigGetOptions,
  heartbeatConfigGetSetQueryData,
  heartbeatRunsGetInfiniteQueryKey,
  retrospectiveConfigGetOptions,
  retrospectiveRunsGetInfiniteQueryKey,
  useConsolidationRunnowPostMutation,
  useHeartbeatConfigPutMutation,
  useHeartbeatRunnowPostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import {
  scheduleUsageSummaryQueryOptions,
  type ScheduleRowUsage,
  SYSTEM_TASK_URL_IDS,
  zeroScheduleUsageSummary,
} from "@/domains/settings/utils/schedule-formatters";
import { captureError } from "@/lib/sentry/capture-error";
import { toast } from "@vellumai/design-library/components/toast";

import type {
  ScheduleUsageSummary,
  SystemTaskKind,
} from "@/domains/settings/types/schedules";

const STALE_TIME = 10_000;

function deriveUsage(
  isLoading: boolean,
  isError: boolean,
  urlId: string,
  usageSummaryById: Map<string, ScheduleUsageSummary>,
): ScheduleRowUsage {
  if (isLoading) return { status: "loading" };
  if (isError) return { status: "error" };
  return {
    status: "ready",
    summary: usageSummaryById.get(urlId) ?? zeroScheduleUsageSummary(urlId),
  };
}

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
  // Usage summary
  // ---------------------------------------------------------------------------

  const {
    data: usageSummaries,
    isLoading: isUsageSummaryLoading,
    isError: isUsageSummaryError,
    refetch: refetchUsageSummary,
  } = useQuery(
    scheduleUsageSummaryQueryOptions(assistantId, tz, Boolean(assistantId)),
  );

  // ---------------------------------------------------------------------------
  // Derived usage stats
  // ---------------------------------------------------------------------------

  const usageSummaryById = useMemo(
    () =>
      new Map(
        (usageSummaries ?? []).map((summary) => [summary.scheduleId, summary]),
      ),
    [usageSummaries],
  );

  const heartbeatUsage: ScheduleRowUsage = useMemo(
    () =>
      deriveUsage(
        isUsageSummaryLoading,
        isUsageSummaryError,
        SYSTEM_TASK_URL_IDS.heartbeat,
        usageSummaryById,
      ),
    [isUsageSummaryError, isUsageSummaryLoading, usageSummaryById],
  );

  const consolidationUsage: ScheduleRowUsage = useMemo(
    () =>
      deriveUsage(
        isUsageSummaryLoading,
        isUsageSummaryError,
        SYSTEM_TASK_URL_IDS.consolidation,
        usageSummaryById,
      ),
    [isUsageSummaryError, isUsageSummaryLoading, usageSummaryById],
  );

  const retrospectiveUsage: ScheduleRowUsage = useMemo(
    () =>
      deriveUsage(
        isUsageSummaryLoading,
        isUsageSummaryError,
        SYSTEM_TASK_URL_IDS.retrospective,
        usageSummaryById,
      ),
    [isUsageSummaryError, isUsageSummaryLoading, usageSummaryById],
  );

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  const invalidateSystemTaskQueries = (kind: SystemTaskKind) => {
    if (!assistantId) return;
    const keysForKind = {
      heartbeat: {
        config: heartbeatConfigGetOptions(pathOpts).queryKey,
        infinite: heartbeatRunsGetInfiniteQueryKey(pathOpts),
      },
      consolidation: {
        config: consolidationConfigGetOptions(pathOpts).queryKey,
        infinite: consolidationRunsGetInfiniteQueryKey(pathOpts),
      },
      retrospective: {
        config: retrospectiveConfigGetOptions(pathOpts).queryKey,
        infinite: retrospectiveRunsGetInfiniteQueryKey(pathOpts),
      },
    }[kind];
    void queryClient.invalidateQueries({
      queryKey: scheduleUsageSummaryQueryOptions(assistantId, tz).queryKey,
    });
    void queryClient.invalidateQueries({ queryKey: keysForKind.config });
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
    void refetchUsageSummary();
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
