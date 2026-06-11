import { ChevronRight } from "lucide-react";

import { ScheduleUsageStats } from "@/domains/settings/components/schedule-shared-ui";
import {
  formatTimestamp,
  type PastOneTimeStatus,
  type ScheduleRowUsage,
} from "@/domains/settings/utils/schedule-formatters";
import { Tag } from "@vellumai/design-library/components/tag";
import { Toggle } from "@vellumai/design-library/components/toggle";

import type { Schedule } from "@/domains/settings/types/schedules";

function cadenceTextForRow(schedule: Schedule): string | null {
  const cadence = schedule.cadenceDescription.trim();
  if (!cadence) return null;
  if (schedule.isOneShot) return null;
  if (cadence === schedule.description.trim()) return null;
  return cadence;
}

function descriptionTextForRow(schedule: Schedule): string | null {
  const description = schedule.description.trim();
  if (!description) return null;
  if (description.toLowerCase() === schedule.name.trim().toLowerCase()) {
    return null;
  }
  return description;
}

function timestampTextForRow(
  schedule: Schedule,
  isPast: boolean,
): string | null {
  if (schedule.lastRunAt != null) {
    return `Last ${formatTimestamp(schedule.lastRunAt)}`;
  }
  if (schedule.nextRunAt != null) {
    return isPast
      ? `Scheduled ${formatTimestamp(schedule.nextRunAt)}`
      : `Next ${formatTimestamp(schedule.nextRunAt)}`;
  }
  return null;
}

export function ScheduleRow({
  schedule,
  usage,
  onClick,
  onToggle,
  onOpenUsage,
  pastStatus,
}: {
  schedule: Schedule;
  usage: ScheduleRowUsage;
  onClick: () => void;
  onToggle?: (enabled: boolean) => void;
  onOpenUsage: () => void;
  /** When set, the row is an elapsed one-shot: status tag instead of toggle. */
  pastStatus?: PastOneTimeStatus;
}) {
  const cadenceText = cadenceTextForRow(schedule);
  const descriptionText = descriptionTextForRow(schedule);
  const timestampText = timestampTextForRow(schedule, pastStatus != null);

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md px-2 py-3 transition-colors hover:bg-[var(--surface-hover)] [&+&]:border-t [&+&]:border-[var(--border-base)]">
      <button
        type="button"
        onClick={onClick}
        className="min-w-0 flex-1 cursor-pointer text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
      >
        <div className="flex items-center gap-2">
          <span className="truncate text-body-medium-default text-[var(--content-default)]">
            {schedule.name}
          </span>
        </div>
        {descriptionText ? (
          <p className="mt-0.5 truncate text-body-small-default text-[var(--content-tertiary)]">
            {descriptionText}
          </p>
        ) : null}
      </button>
      {(cadenceText || timestampText) && (
        <div className="flex shrink-0 items-center gap-3 text-body-small-default text-[var(--content-tertiary)]">
          {cadenceText ? (
            <span className="shrink-0 text-[var(--content-secondary)]">
              {cadenceText}
            </span>
          ) : null}
          {timestampText ? (
            <span className="shrink-0">{timestampText}</span>
          ) : null}
        </div>
      )}
      <div className="flex shrink-0 items-center gap-3">
        <ScheduleUsageStats
          scheduleName={schedule.name}
          usage={usage}
          onOpenUsage={onOpenUsage}
        />
        {pastStatus ? (
          <Tag tone={pastStatus.tone}>{pastStatus.label}</Tag>
        ) : (
          <Toggle
            checked={schedule.enabled}
            onChange={(enabled) => onToggle?.(enabled)}
            aria-label={`Toggle ${schedule.name}`}
          />
        )}
        <button
          type="button"
          onClick={onClick}
          aria-label={`Open ${schedule.name}`}
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-[var(--content-tertiary)] transition-colors hover:bg-[var(--surface-hover)]"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
