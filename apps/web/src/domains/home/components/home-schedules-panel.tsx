import { Calendar } from "lucide-react";

import { HomeEmptyState } from "@/domains/home/components/home-empty-state";
import { HomeScheduleRow } from "@/domains/home/components/home-schedule-row";
import { Notice } from "@vellumai/design-library/components/notice";

import type { Schedule } from "@/domains/settings/types/schedules";
import type { ScheduleRowUsage } from "@/domains/settings/utils/schedule-formatters";

export interface HomeSchedulesPanelProps {
  recurring: Schedule[];
  oneTime: Schedule[];
  usageForSchedule: (id: string) => ScheduleRowUsage;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
  onToggle: (id: string, enabled: boolean) => void;
  onSelectSchedule: (id: string) => void;
  selectedScheduleId: string | null;
}

export function HomeSchedulesPanel({
  recurring,
  oneTime,
  usageForSchedule,
  isLoading,
  isError,
  refetch,
  onToggle,
  onSelectSchedule,
  selectedScheduleId,
}: HomeSchedulesPanelProps) {
  const renderScheduleRow = (schedule: Schedule) => (
    <HomeScheduleRow
      key={schedule.id}
      schedule={schedule}
      usage={usageForSchedule(schedule.id)}
      selected={schedule.id === selectedScheduleId}
      onClick={() => onSelectSchedule(schedule.id)}
      onToggle={(enabled) => onToggle(schedule.id, enabled)}
    />
  );

  const renderBody = () => {
    if (isLoading) {
      return (
        <div className="space-y-3">
          {Array.from({ length: 2 }, (_, i) => (
            <div
              key={i}
              className="h-12 animate-pulse rounded-md bg-[var(--surface-muted)]"
            />
          ))}
        </div>
      );
    }

    if (isError && recurring.length === 0) {
      return (
        <Notice
          tone="error"
          actions={
            <button
              type="button"
              onClick={refetch}
              className="cursor-pointer underline hover:no-underline"
            >
              Retry
            </button>
          }
        >
          Failed to load schedules.
        </Notice>
      );
    }

    if (recurring.length === 0 && oneTime.length === 0) {
      return (
        <HomeEmptyState
          icon={Calendar}
          title="No schedules yet"
          description="Tasks your assistant runs for you on a schedule will appear here."
        />
      );
    }

    return (
      <div>
        {recurring.map(renderScheduleRow)}
        {oneTime.length > 0 ? (
          <>
            <p className="mt-3 px-2 text-label-small-default text-[var(--content-tertiary)]">
              One-time
            </p>
            {oneTime.map(renderScheduleRow)}
          </>
        ) : null}
      </div>
    );
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">{renderBody()}</div>
  );
}
