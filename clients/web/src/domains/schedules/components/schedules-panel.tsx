import { Calendar, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

import { PageEmptyState } from "@/components/page-empty-state";
import { useTranslation } from "@/i18n";
import { ScheduleRow } from "@/domains/schedules/components/schedule-row";
import { Button } from "@vellumai/design-library";
import { Collapsible } from "@vellumai/design-library/components/collapsible";
import { Notice } from "@vellumai/design-library/components/notice";
import { Skeleton } from "@vellumai/design-library/components/skeleton";

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
   * Opens the "move every schedule onto the current default model" flow.
   * Omitted when there is nothing to move, so the action only appears once
   * some schedule is running on a model other than the current default.
   */
  onRebaseProfiles?: () => void;
  /** Display name of the profile the rebase would move schedules onto. */
  defaultProfileLabel?: string;
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
  onRebaseProfiles,
  defaultProfileLabel,
  systemTasksSlot,
}: SchedulesPanelProps) {
  const { t } = useTranslation("schedules");
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
            <span>
              {t("schedulesPanel.pastToggle", { count: pastOneTime.length })}
            </span>
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
            <Skeleton key={i} className="h-12 rounded-md" />
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
              {t("schedulesPanel.retry")}
            </button>
          }
        >
          {t("schedulesPanel.loadFailed")}
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
          title={t("schedulesPanel.emptyTitle")}
          description={t("schedulesPanel.emptyDescription")}
          actions={
            <>
              <Button variant="primary" size="regular" onClick={onStartNewChat}>
                {t("schedulesPanel.newConversation")}
              </Button>
              <span className="text-body-small-default text-[var(--content-tertiary)]">
                {t("schedulesPanel.emptyActionsSeparator")}
              </span>
              <Button
                variant="outlined"
                size="regular"
                onClick={onCreateSchedule}
              >
                {t("schedulesPanel.createSchedule")}
              </Button>
            </>
          }
        />
      );
    }

    return (
      <div>
        {onRebaseProfiles && defaultProfileLabel ? (
          <div className="mb-1 flex min-w-0 justify-end">
            <Button
              variant="outlined"
              size="compact"
              onClick={onRebaseProfiles}
              className="max-w-full truncate"
            >
              {t("schedulesPanel.useProfileForAll", {
                profile: defaultProfileLabel,
              })}
            </Button>
          </div>
        ) : null}
        {recurring.map(renderScheduleRow)}
        {oneTime.length > 0 ? (
          <>
            <p className="mt-3 px-2 text-label-small-default text-[var(--content-tertiary)]">
              {t("schedulesPanel.oneTimeHeading")}
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
