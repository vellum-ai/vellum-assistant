import {
  formatScheduleCost,
  formatScheduleRunCount,
  type ScheduleRowUsage,
} from "@/domains/settings/utils/schedule-formatters";

// ---------------------------------------------------------------------------
// StatusDot — shared status indicator for schedules and runs
// ---------------------------------------------------------------------------

export function StatusDot({ status }: { status: string | null }) {
  const color =
    status === "ok" || status === "completed"
      ? "var(--system-positive-strong)"
      : status === "error" || status === "failed"
        ? "var(--system-negative-strong)"
        : "var(--content-tertiary)";
  return (
    <span
      className="inline-block h-2 w-2 rounded-full"
      style={{ backgroundColor: color }}
      aria-label={status ?? "unknown"}
    />
  );
}

// ---------------------------------------------------------------------------
// ScheduleUsageStats — cost + run count display for schedule rows
// ---------------------------------------------------------------------------

// Column labels live once in ScheduleListColumnsHeader; rows render bare
// values. Zero values are dimmed so the eye lands on rows that actually
// cost or ran something.

export function ScheduleUsageStats({
  scheduleName,
  usage,
  onOpenUsage,
}: {
  scheduleName: string;
  usage: ScheduleRowUsage;
  onOpenUsage?: () => void;
}) {
  if (usage.status === "loading") {
    return (
      <div
        aria-label="Loading schedule usage"
        className="flex w-[156px] shrink-0 items-center justify-end gap-3"
      >
        <span className="h-5 w-16 animate-pulse rounded bg-[var(--surface-muted)]" />
        <span className="h-5 w-16 animate-pulse rounded bg-[var(--surface-muted)]" />
      </div>
    );
  }

  const isUnavailable = usage.status === "error";
  const cost = isUnavailable
    ? "--"
    : formatScheduleCost(usage.summary.totalEstimatedCostUsd);
  const runs = isUnavailable
    ? "--"
    : formatScheduleRunCount(usage.summary.runCount);
  const costIsZero =
    usage.status === "ready" && !(usage.summary.totalEstimatedCostUsd > 0);
  const runsIsZero = usage.status === "ready" && usage.summary.runCount === 0;

  const costClass = costIsZero
    ? "text-[var(--content-tertiary)]"
    : "text-[var(--content-default)]";
  const runsClass = runsIsZero
    ? "text-[var(--content-tertiary)]"
    : "text-[var(--content-default)]";

  return (
    <div className="flex w-[156px] shrink-0 items-center justify-end gap-3 text-right text-body-small-default">
      {onOpenUsage ? (
        <button
          type="button"
          onClick={onOpenUsage}
          aria-label={`View usage for ${scheduleName}`}
          className={`min-w-[64px] cursor-pointer rounded px-1 py-0.5 text-right transition-colors hover:bg-[var(--surface-hover)] ${costClass}`}
        >
          {cost}
        </button>
      ) : (
        <span
          aria-label={`Cost for ${scheduleName} in the last 7 days: ${cost}`}
          className={`block min-w-[64px] px-1 py-0.5 ${costClass}`}
        >
          {cost}
        </span>
      )}
      <span
        aria-label={`Runs for ${scheduleName} in the last 7 days: ${runs}`}
        className={`block min-w-[64px] px-1 py-0.5 ${runsClass}`}
      >
        {runs}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ScheduleListColumnsHeader — one-time column labels for the schedule list
// ---------------------------------------------------------------------------

/**
 * Mirrors ScheduleRow's right-side layout (stats block + toggle + chevron)
 * so the labels line up over the value columns.
 */
export function ScheduleListColumnsHeader() {
  return (
    <div aria-hidden="true" className="flex items-center gap-3 px-2 pb-1">
      <div className="min-w-0 flex-1" />
      <div className="flex shrink-0 items-center gap-3">
        <div className="flex w-[156px] items-center justify-end gap-3 text-right text-label-small-default text-[var(--content-tertiary)]">
          <span className="block min-w-[64px] px-1">Cost (7d)</span>
          <span className="block min-w-[64px] px-1">Runs (7d)</span>
        </div>
        <span className="block w-9" />
        <span className="block w-7" />
      </div>
    </div>
  );
}
