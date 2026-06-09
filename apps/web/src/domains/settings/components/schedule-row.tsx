import { ChevronRight } from "lucide-react";

import {
  ScheduleUsageStats,
  StatusDot,
} from "@/domains/settings/components/schedule-shared-ui";
import {
  formatTimestamp,
  MODE_TONE,
  type ScheduleRowUsage,
} from "@/domains/settings/utils/schedule-formatters";
import { Tag } from "@vellumai/design-library/components/tag";
import { Toggle } from "@vellumai/design-library/components/toggle";

import type { Schedule } from "@/domains/settings/types/schedules";

export function ScheduleRow({
  schedule,
  usage,
  onClick,
  onToggle,
  onOpenUsage,
}: {
  schedule: Schedule;
  usage: ScheduleRowUsage;
  onClick: () => void;
  onToggle: (enabled: boolean) => void;
  onOpenUsage: () => void;
}) {
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
          <Tag tone={MODE_TONE[schedule.mode] ?? "neutral"}>
            {schedule.mode}
          </Tag>
        </div>
        <div className="mt-0.5 flex items-center gap-3 text-body-small-default text-[var(--content-tertiary)]">
          <span className="truncate">{schedule.description}</span>
          {schedule.lastRunAt && (
            <span className="flex shrink-0 items-center gap-1">
              <StatusDot status={schedule.lastStatus} />
              {formatTimestamp(schedule.lastRunAt)}
            </span>
          )}
        </div>
      </button>
      <div className="flex shrink-0 items-center gap-3">
        <ScheduleUsageStats
          scheduleName={schedule.name}
          usage={usage}
          onOpenUsage={onOpenUsage}
        />
        <Toggle
          checked={schedule.enabled}
          onChange={onToggle}
          aria-label={`Toggle ${schedule.name}`}
        />
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
