import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import {
  schedulesListQueryOptions,
  toggleSchedule,
} from "@/domains/settings/api/schedules";
import type { Schedule } from "@/domains/settings/types/schedules";
import {
  groupSchedules,
  type ScheduleRowUsage,
  scheduleUsageSummaryQueryOptions,
  zeroScheduleUsageSummary,
} from "@/domains/settings/utils/schedule-formatters";
import { captureError } from "@/lib/sentry/capture-error";
import { useEffectiveTimezone } from "@/utils/use-effective-timezone";
import { toast } from "@vellumai/design-library/components/toast";

export interface SchedulesData {
  recurring: Schedule[];
  oneTime: Schedule[];
  /** One-shot schedules that have already fired (or been cancelled). */
  pastOneTime: Schedule[];
  usageForSchedule: (id: string) => ScheduleRowUsage;
  handleToggle: (id: string, enabled: boolean) => Promise<void>;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

/**
 * Composes the schedule list + per-schedule usage the Schedules page
 * needs, sharing query keys (and therefore cache) with the Settings schedules
 * page.
 */
export function useSchedulesData(
  assistantId: string | undefined,
): SchedulesData {
  const tz = useEffectiveTimezone();
  // Stable per-mount timestamp for grouping one-time schedules (calling
  // Date.now() directly during render is impure). Matches the Settings page.
  const [now] = useState(() => Date.now());

  const {
    data: schedules,
    isLoading,
    isError,
    refetch: refetchSchedules,
  } = useQuery(schedulesListQueryOptions(assistantId));

  const {
    data: usageSummaries,
    isLoading: isUsageSummaryLoading,
    isError: isUsageSummaryError,
  } = useQuery(scheduleUsageSummaryQueryOptions(assistantId, tz, true));

  const { recurring, oneTime, pastOneTime } = useMemo(() => {
    const grouped = groupSchedules(schedules ?? [], now);
    return {
      recurring: grouped.recurring,
      oneTime: grouped.upcomingOneTime,
      pastOneTime: grouped.pastOneTime,
    };
  }, [now, schedules]);

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
    pastOneTime,
    usageForSchedule,
    handleToggle,
    isLoading,
    isError,
    refetch,
  };
}
