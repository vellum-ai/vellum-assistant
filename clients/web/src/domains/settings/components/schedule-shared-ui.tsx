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

// Rows render bare values (no inline column labels). Zero values are dimmed
// so the eye lands on rows that actually cost or ran something.

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
