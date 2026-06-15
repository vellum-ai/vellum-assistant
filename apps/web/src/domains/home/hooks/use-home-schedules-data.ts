import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { fetchSchedules, toggleSchedule } from "@/domains/settings/api/schedules";
import { useSystemTasks } from "@/domains/settings/hooks/use-system-tasks";
import type { Schedule } from "@/domains/settings/types/schedules";
import {
  formatScheduleCost,
  groupSchedules,
  type ScheduleRowUsage,
  scheduleUsageSummaryQueryOptions,
  systemTaskUsageCost,
  totalUsageCost,
  zeroScheduleUsageSummary,
} from "@/domains/settings/utils/schedule-formatters";
import { captureError } from "@/lib/sentry/capture-error";
import { assistantSchedulesQueryKey } from "@/lib/sync/query-tags";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useEffectiveTimezone } from "@/utils/use-effective-timezone";
import { toast } from "@vellumai/design-library/components/toast";

type CostStatus = "loading" | "error" | "ready";

export interface HomeSchedulesData {
  recurring: Schedule[];
  oneTime: Schedule[];
  usageForSchedule: (id: string) => ScheduleRowUsage;
  schedulesTotalCostLabel: string;
  schedulesCostStatus: CostStatus;
  systemTotalCostLabel: string;
  systemCostStatus: CostStatus;
  systemTasks: ReturnType<typeof useSystemTasks>;
  showSystemTaskToggles: boolean;
  handleToggle: (id: string, enabled: boolean) => Promise<void>;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

/**
 * Composes the same schedule + system-task data the Settings schedules page
 * wires inline, returning a single clean object for the homepage summary
 * cards. Shares query keys with `SchedulesPage`, so the cache is shared.
 */
export function useHomeSchedulesData(
  assistantId: string | undefined,
): HomeSchedulesData {
  const tz = useEffectiveTimezone();

  const assistantFlagsHydrated = useAssistantFeatureFlagStore.use.hasHydrated();
  const systemScheduleToggles =
    useAssistantFeatureFlagStore.use.systemScheduleToggles();
  const showSystemTaskToggles = assistantFlagsHydrated && systemScheduleToggles;

  // -------------------------------------------------------------------------
  // User schedule queries
  // -------------------------------------------------------------------------

  const {
    data: schedules,
    isLoading,
    isError,
    refetch: refetchSchedules,
  } = useQuery({
    queryKey: assistantSchedulesQueryKey(assistantId),
    queryFn: () =>
      assistantId ? fetchSchedules(assistantId) : Promise.resolve([]),
    staleTime: 10_000,
  });

  const {
    data: usageSummaries,
    isLoading: isUsageSummaryLoading,
    isError: isUsageSummaryError,
  } = useQuery(scheduleUsageSummaryQueryOptions(assistantId, tz, true));

  // -------------------------------------------------------------------------
  // System tasks (heartbeat + consolidation)
  // -------------------------------------------------------------------------

  const systemTasks = useSystemTasks(assistantId, tz);

  // -------------------------------------------------------------------------
  // Derived state
  // -------------------------------------------------------------------------

  const { recurring, oneTime } = useMemo(() => {
    const grouped = groupSchedules(schedules ?? [], Date.now());
    return {
      recurring: grouped.recurring,
      oneTime: [...grouped.upcomingOneTime, ...grouped.pastOneTime],
    };
  }, [schedules]);

  const usageSummaryByScheduleId = useMemo(
    () =>
      new Map(
        (usageSummaries ?? []).map((summary) => [summary.scheduleId, summary]),
      ),
    [usageSummaries],
  );

  const usageForSchedule = useCallback(
    (id: string): ScheduleRowUsage => {
      if (isUsageSummaryLoading) return { status: "loading" };
      if (isUsageSummaryError) return { status: "error" };
      return {
        status: "ready",
        summary:
          usageSummaryByScheduleId.get(id) ?? zeroScheduleUsageSummary(id),
      };
    },
    [isUsageSummaryError, isUsageSummaryLoading, usageSummaryByScheduleId],
  );

  // -------------------------------------------------------------------------
  // Per-group 7-day cost labels
  // -------------------------------------------------------------------------

  const schedulesCostStatus: CostStatus = isUsageSummaryLoading
    ? "loading"
    : isUsageSummaryError
      ? "error"
      : "ready";

  const schedulesTotalCostLabel =
    schedulesCostStatus === "ready"
      ? formatScheduleCost(totalUsageCost(usageSummaries ?? []))
      : "";

  const { heartbeatUsage, consolidationUsage } = systemTasks;
  const systemCostStatus: CostStatus =
    heartbeatUsage.status === "loading" ||
    consolidationUsage.status === "loading"
      ? "loading"
      : heartbeatUsage.status === "error" || consolidationUsage.status === "error"
        ? "error"
        : "ready";

  const systemTotalCostLabel =
    systemCostStatus === "ready"
      ? formatScheduleCost(
          systemTaskUsageCost(heartbeatUsage) +
            systemTaskUsageCost(consolidationUsage),
        )
      : "";

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  const handleToggle = useCallback(
    async (id: string, enabled: boolean) => {
      if (!assistantId) return;
      try {
        await toggleSchedule(assistantId, id, enabled);
        void refetchSchedules();
      } catch (error) {
        captureError(error, { context: "schedule_toggle" });
        toast.error("Failed to toggle schedule.");
      }
    },
    [assistantId, refetchSchedules],
  );

  const refetch = useCallback(() => {
    void refetchSchedules();
  }, [refetchSchedules]);

  return {
    recurring,
    oneTime,
    usageForSchedule,
    schedulesTotalCostLabel,
    schedulesCostStatus,
    systemTotalCostLabel,
    systemCostStatus,
    systemTasks,
    showSystemTaskToggles,
    handleToggle,
    isLoading,
    isError,
    refetch,
  };
}
