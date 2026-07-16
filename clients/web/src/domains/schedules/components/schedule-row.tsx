import { Fragment } from "react";

import { ChevronRight } from "lucide-react";

import {
  formatScheduleCost,
  formatScheduleRunCount,
  formatTimestamp,
  type ScheduleRowUsage,
} from "@/domains/settings/utils/schedule-formatters";
import { Toggle } from "@vellumai/design-library/components/toggle";

import type { Schedule } from "@/domains/settings/types/schedules";

function inlineUsage(usage: ScheduleRowUsage) {
  if (usage.status === "loading") {
    return (
      <>
        <span className="h-4 w-12 animate-pulse rounded bg-[var(--surface-muted)]" />
        <span className="h-4 w-10 animate-pulse rounded bg-[var(--surface-muted)]" />
      </>
    );
  }
  if (usage.status === "error") {
    return (
      <span className="text-body-small-default text-[var(--content-tertiary)]">
        —
      </span>
    );
  }
  const { summary } = usage;
  return (
    <>
      <span className="text-body-small-default text-[var(--content-secondary)]">
        {formatScheduleCost(summary.totalEstimatedCostUsd)}
      </span>
      <span className="text-body-small-default text-[var(--content-secondary)]">
        {formatScheduleRunCount(summary.runCount)}
      </span>
    </>
  );
}

/**
 * Presentational row layout for schedule-like entries: toggle on the far
 * left, then name + `cadence · timestamp` meta, then inline cost · runs ·
 * chevron on the right. Matches the Figma "Scheduled Jobs" design.
 */
export function ScheduleRowShell({
  name,
  metaParts,
  usage,
  enabled,
  selected,
  onClick,
  onToggle,
  toggleAriaLabel,
}: {
  name: string;
  metaParts: string[];
  usage: ScheduleRowUsage;
  enabled: boolean;
  selected?: boolean;
  onClick: () => void;
  /** Omit to render a read-only row (e.g. a past one-shot) with no toggle. */
  onToggle?: (enabled: boolean) => void;
  toggleAriaLabel?: string;
}) {
  return (
    <div
      className={`flex items-center gap-3 rounded-md px-2 py-3 transition-colors [&+&]:border-t [&+&]:border-[var(--border-base)] ${
        selected
          ? "bg-[var(--surface-active)]"
          : "hover:bg-[var(--surface-hover)]"
      }`}
    >
      {onToggle ? (
        <Toggle
          checked={enabled}
          onChange={onToggle}
          aria-label={toggleAriaLabel}
        />
      ) : null}
      <button
        type="button"
        onClick={onClick}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-4 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-body-medium-default text-[var(--content-default)]">
            {name}
          </span>
          {metaParts.length > 0 ? (
            <span className="flex min-w-0 items-center gap-2 text-label-small-default text-[var(--content-tertiary)]">
              {metaParts.map((part, index) => (
                <Fragment key={index}>
                  {index > 0 ? (
                    <span className="h-[3px] w-[3px] shrink-0 rounded-full bg-[var(--content-tertiary)]" />
                  ) : null}
                  <span className="truncate">{part}</span>
                </Fragment>
              ))}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-4">
          {inlineUsage(usage)}
          <ChevronRight className="h-4 w-4 text-[var(--content-tertiary)]" />
        </div>
      </button>
    </div>
  );
}

export function ScheduleRow({
  schedule,
  usage,
  selected,
  onClick,
  onToggle,
}: {
  schedule: Schedule;
  usage: ScheduleRowUsage;
  selected?: boolean;
  onClick: () => void;
  /** Omit for read-only rows (past one-shots) — hides the enable/disable toggle. */
  onToggle?: (enabled: boolean) => void;
}) {
  const cadence = schedule.isOneShot
    ? ""
    : schedule.cadenceDescription.trim();
  const runAt = schedule.lastRunAt ?? schedule.nextRunAt;
  const metaParts = [cadence, runAt ? formatTimestamp(runAt) : ""].filter(
    Boolean,
  );

  return (
    <ScheduleRowShell
      name={schedule.name}
      metaParts={metaParts}
      usage={usage}
      enabled={schedule.enabled}
      selected={selected}
      onClick={onClick}
      onToggle={onToggle}
      toggleAriaLabel={onToggle ? `Toggle ${schedule.name}` : undefined}
    />
  );
}
