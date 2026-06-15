import { Calendar } from "lucide-react";

import { HomeScheduleRow } from "@/domains/home/components/home-schedule-row";
import { SummaryCardHeader } from "@/domains/home/components/schedule-summary-card";
import { Card } from "@vellumai/design-library";
import { Notice } from "@vellumai/design-library/components/notice";

import type { Schedule } from "@/domains/settings/types/schedules";
import type { ScheduleRowUsage } from "@/domains/settings/utils/schedule-formatters";

export const SCHEDULES_ICON = (
  <Calendar className="h-5 w-5 text-[var(--content-secondary)]" />
);

const CARD_TITLE = "Active Schedules";
const CARD_SUBTITLE = "Tasks your assistant runs for you on a set schedule.";

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
  if (isLoading) {
    return (
      <Card padding="lg">
        <SummaryCardHeader
          icon={SCHEDULES_ICON}
          title={CARD_TITLE}
          subtitle={CARD_SUBTITLE}
        />
        <div className="mt-4 space-y-3">
          {Array.from({ length: 2 }, (_, i) => (
            <div
              key={i}
              className="h-12 animate-pulse rounded-md bg-[var(--surface-muted)]"
            />
          ))}
        </div>
      </Card>
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

  return (
    <Card padding="lg">
      <SummaryCardHeader
        icon={SCHEDULES_ICON}
        title={CARD_TITLE}
        subtitle={CARD_SUBTITLE}
      />
      <div className="mt-4">
        {recurring.length === 0 && oneTime.length === 0 ? (
          <p className="text-body-small-default text-[var(--content-tertiary)]">
            No schedules yet
          </p>
        ) : (
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
        )}
      </div>
    </Card>
  );
}
