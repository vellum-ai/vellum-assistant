import { Calendar, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

import { PageEmptyState } from "@/components/page-empty-state";
import { ScheduleRow } from "@/domains/schedules/components/schedule-row";
import { Button } from "@vellumai/design-library";
import { Collapsible } from "@vellumai/design-library/components/collapsible";
import { Notice } from "@vellumai/design-library/components/notice";

import type { Schedule } from "@/domains/settings/types/schedules";
import type { ScheduleRowUsage } from "@/domains/settings/utils/schedule-formatters";

export interface SchedulesPanelProps {
  recurring: Schedule[];
  oneTime: Schedule[];
  /** One-shot schedules that have already fired — shown read-only in a collapsible. */
  pastOneTime: Schedule[];
  usageForSchedule: (id: string) => ScheduleRowUsage;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
  onToggle: (id: string, enabled: boolean) => void;
  onSelectSchedule: (id: string) => void;
  selectedScheduleId: string | null;
  onStartNewChat: () => void;
  onCreateSchedule: () => void;
  /** Controlled open-state for the "Past" accordion (lifted so it survives the
   * section remount when the detail drawer opens). */
  pastOpen: boolean;
  onPastOpenChange: (open: boolean) => void;
  /**
   * Built-in system schedules (heartbeat, consolidation, memory retrospective),
   * rendered below the user list so both share one scroll region. Self-hides
   * when there are no system tasks to show.
   */
  systemTasksSlot?: ReactNode;
}

export function SchedulesPanel({
  recurring,
  oneTime,
  pastOneTime,
  usageForSchedule,
  isLoading,
  isError,
  refetch,
  onToggle,
  onSelectSchedule,
  selectedScheduleId,
  onStartNewChat,
  onCreateSchedule,
  pastOpen,
  onPastOpenChange,
  systemTasksSlot,
}: SchedulesPanelProps) {
  const renderScheduleRow = (schedule: Schedule) => (
    <ScheduleRow
      key={schedule.id}
      schedule={schedule}
      usage={usageForSchedule(schedule.id)}
      selected={schedule.id === selectedScheduleId}
      onClick={() => onSelectSchedule(schedule.id)}
      onToggle={(enabled) => onToggle(schedule.id, enabled)}
    />
  );

  // One-shots are read-only: no toggle. Upcoming ones fire once (nothing to
  // pause/re-enable meaningfully); past ones have already fired.
  const renderOneTimeRow = (schedule: Schedule) => (
    <ScheduleRow
      key={schedule.id}
      schedule={schedule}
      usage={usageForSchedule(schedule.id)}
      selected={schedule.id === selectedScheduleId}
      onClick={() => onSelectSchedule(schedule.id)}
    />
  );

  const pastSection =
    pastOneTime.length > 0 ? (
      <Collapsible.Root
        type="single"
        collapsible
        className="mt-3"
        value={pastOpen ? "past" : ""}
        onValueChange={(v) => onPastOpenChange(v === "past")}
      >
        <Collapsible.Item value="past">
          <Collapsible.Trigger className="group gap-[var(--app-spacing-xs)] px-2 text-label-small-default text-[var(--content-tertiary)]">
            <ChevronRight
              size={14}
              aria-hidden
              className="shrink-0 transition-transform group-data-[state=open]:rotate-90"
            />
            <span>Past ({pastOneTime.length})</span>
          </Collapsible.Trigger>
          <Collapsible.Content>
            <div className="pt-1">{pastOneTime.map(renderOneTimeRow)}</div>
          </Collapsible.Content>
        </Collapsible.Item>
      </Collapsible.Root>
    ) : null;

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

    if (
      recurring.length === 0 &&
      oneTime.length === 0 &&
      pastOneTime.length === 0
    ) {
      return (
        <PageEmptyState
          icon={Calendar}
          title="No schedules yet"
          description="Ask your assistant to set one up, or create one yourself."
          actions={
            <>
              <Button
                variant="primary"
                size="regular"
                onClick={onStartNewChat}
              >
                New Conversation
              </Button>
              <span className="text-body-small-default text-[var(--content-tertiary)]">
                or
              </span>
              <Button
                variant="outlined"
                size="regular"
                onClick={onCreateSchedule}
              >
                Create schedule
              </Button>
            </>
          }
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
            {oneTime.map(renderOneTimeRow)}
          </>
        ) : null}
        {pastSection}
      </div>
    );
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {renderBody()}
      {systemTasksSlot ? (
        <div className="mt-[var(--app-spacing-lg)]">{systemTasksSlot}</div>
      ) : null}
    </div>
  );
}
