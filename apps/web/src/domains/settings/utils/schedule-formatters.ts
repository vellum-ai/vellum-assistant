import type {
  Schedule,
  ScheduleRun,
  ScheduleUsageSummary,
  SystemTaskKind,
} from "@/domains/settings/types/schedules";
import type {
  ConsolidationConfigGetResponse,
  HeartbeatConfigGetResponse,
} from "@/generated/daemon/types.gen";
import type { TagTone } from "@vellumai/design-library/components/tag";

import { fetchScheduleUsageSummary } from "@/domains/settings/api/schedules";
import { resolveScheduleUsageWindow } from "@/domains/settings/utils/schedule-usage-window";
import { assistantScheduleUsageSummaryQueryKey } from "@/lib/sync/query-tags";

// ---------------------------------------------------------------------------
// Timestamp / duration / cost formatting
// ---------------------------------------------------------------------------

export function formatTimestamp(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const costFormatter = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatScheduleCost(cost: number | null | undefined): string {
  if (cost == null || !Number.isFinite(cost)) return "—";
  return costFormatter.format(cost);
}

export function formatScheduleRunCount(count: number): string {
  const formatted = count.toLocaleString();
  return `${formatted} ${count === 1 ? "run" : "runs"}`;
}

export function formatInterval(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 60 && minutes % 60 === 0) {
    return `Every ${minutes / 60} hr`;
  }
  return `Every ${minutes} min`;
}

/**
 * Flatten infinite-query run pages into a single newest-first list,
 * deduping by run id (a row can repeat across a page boundary when new
 * runs land between page fetches).
 */
export function flattenRunPages(
  pages: { runs: ScheduleRun[] }[] | undefined,
): ScheduleRun[] | undefined {
  if (!pages) return undefined;
  const seen = new Set<string>();
  const runs: ScheduleRun[] = [];
  for (const page of pages) {
    for (const run of page.runs) {
      if (seen.has(run.id)) continue;
      seen.add(run.id);
      runs.push(run);
    }
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Schedule / run predicates
// ---------------------------------------------------------------------------

export function canOpenScheduleSourceConversation(schedule: Schedule): boolean {
  return (
    !!schedule.createdFromConversationId &&
    schedule.createdFromConversationExists === true &&
    schedule.createdFromConversationArchivedAt == null
  );
}

export function canOpenScheduleRunConversation(run: ScheduleRun): boolean {
  return (
    !!run.conversationId &&
    run.conversationExists === true &&
    run.conversationArchivedAt == null
  );
}

export function getOpenableScheduleSourceConversationId(
  schedule: Schedule,
): string | null {
  return canOpenScheduleSourceConversation(schedule)
    ? (schedule.createdFromConversationId ?? null)
    : null;
}

export function getOpenableScheduleRunConversationId(
  run: ScheduleRun,
): string | null {
  return canOpenScheduleRunConversation(run)
    ? (run.conversationId ?? null)
    : null;
}

export function hasRunText(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

// ---------------------------------------------------------------------------
// System task helpers
// ---------------------------------------------------------------------------

export const SYSTEM_TASK_URL_IDS = {
  heartbeat: "system-heartbeat",
  consolidation: "system-consolidation",
  retrospective: "system-memory-retrospective",
} as const satisfies Record<SystemTaskKind, string>;

export const SYSTEM_TASK_STATS_RUN_LIMIT = 100;

export function systemTaskKindFromUrlId(
  scheduleId: string | undefined,
): SystemTaskKind | null {
  switch (scheduleId) {
    case SYSTEM_TASK_URL_IDS.heartbeat:
      return "heartbeat";
    case SYSTEM_TASK_URL_IDS.consolidation:
      return "consolidation";
    case SYSTEM_TASK_URL_IDS.retrospective:
      return "retrospective";
    default:
      return null;
  }
}

export function heartbeatSubtitle(config: HeartbeatConfigGetResponse): string {
  if (config.cronExpression) {
    return config.timezone
      ? `Cron: ${config.cronExpression} (${config.timezone})`
      : `Cron: ${config.cronExpression}`;
  }
  let subtitle = formatInterval(config.intervalMs);
  if (config.activeHoursStart != null && config.activeHoursEnd != null) {
    subtitle += ` (${config.activeHoursStart}:00–${config.activeHoursEnd}:00)`;
  }
  return subtitle;
}

export function consolidationSubtitle(
  config: ConsolidationConfigGetResponse,
): string {
  return formatInterval(config.intervalMs);
}

/**
 * Retrospectives are event-driven (per-conversation triggers after activity),
 * not interval-scheduled — so the cadence line describes the trigger instead
 * of formatting `intervalMs`.
 */
export const RETROSPECTIVE_SUBTITLE = "After conversation activity";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MODE_TONE: Record<string, TagTone> = {
  execute: "positive",
  notify: "warning",
  script: "neutral",
};

export const DEFAULT_SCRIPT_TIMEOUT_MS = 60_000;
export const MIN_SCRIPT_TIMEOUT_SECONDS = 1;
export const MAX_SCRIPT_TIMEOUT_SECONDS = 30 * 60;

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

export interface GroupedSchedules {
  recurring: Schedule[];
  upcomingOneTime: Schedule[];
  pastOneTime: Schedule[];
}

// Keyed on the lifecycle status, not lastRunAt/nextRunAt alone: a failed
// attempt awaiting retry keeps lastRunAt set, and an in-flight run is
// `firing` with nextRunAt already due — both are still live, not past.
function isPastOneTime(schedule: Schedule, now: number): boolean {
  if (schedule.status === "fired" || schedule.status === "cancelled") {
    return true;
  }
  if (schedule.status === "firing") return false;
  // active: an enabled one-shot still fires on the next daemon wake even if
  // overdue; a disabled one whose time has passed never will.
  return (
    schedule.nextRunAt == null ||
    (!schedule.enabled && schedule.nextRunAt <= now)
  );
}

export function groupSchedules(
  schedules: Schedule[],
  now: number,
): GroupedSchedules {
  const recurring: Schedule[] = [];
  const upcomingOneTime: Schedule[] = [];
  const pastOneTime: Schedule[] = [];

  for (const s of schedules) {
    if (!s.isOneShot) {
      recurring.push(s);
    } else if (isPastOneTime(s, now)) {
      pastOneTime.push(s);
    } else {
      upcomingOneTime.push(s);
    }
  }

  recurring.sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity);
  });

  upcomingOneTime.sort(
    (a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity),
  );

  pastOneTime.sort((a, b) => {
    const aTime = a.lastRunAt ?? a.nextRunAt ?? 0;
    const bTime = b.lastRunAt ?? b.nextRunAt ?? 0;
    return bTime - aTime;
  });

  return { recurring, upcomingOneTime, pastOneTime };
}

export interface PastOneTimeStatus {
  label: string;
  tone: TagTone;
}

export function pastOneTimeStatus(schedule: Schedule): PastOneTimeStatus {
  // Failure wins over cancellation: failOneShotPermanently (retry cap
  // exhausted) records status "cancelled" with lastStatus "error".
  if (schedule.lastStatus === "error" || schedule.lastStatus === "failed") {
    return { label: "Failed", tone: "negative" };
  }
  if (schedule.status === "cancelled") {
    return { label: "Cancelled", tone: "neutral" };
  }
  if (schedule.lastRunAt != null) {
    return { label: "Completed", tone: "positive" };
  }
  return { label: "Expired", tone: "neutral" };
}

// ---------------------------------------------------------------------------
// Usage summary helpers
// ---------------------------------------------------------------------------

export type ScheduleRowUsage =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; summary: ScheduleUsageSummary };

export function scheduleUsageSummaryQueryOptions(
  assistantId: string | undefined,
  tz: string,
  enabled = true,
) {
  return {
    queryKey: assistantScheduleUsageSummaryQueryKey(assistantId, tz),
    queryFn: () => {
      if (!assistantId) {
        return Promise.resolve<ScheduleUsageSummary[]>([]);
      }
      return fetchScheduleUsageSummary(
        assistantId,
        resolveScheduleUsageWindow(tz),
      );
    },
    enabled,
    staleTime: 10_000,
  };
}

export function zeroScheduleUsageSummary(
  scheduleId: string,
): ScheduleUsageSummary {
  return {
    scheduleId,
    runCount: 0,
    totalEstimatedCostUsd: 0,
    eventCount: 0,
  };
}

export function summarizeRunsForUsage(
  scheduleId: string,
  runs: ScheduleRun[] | undefined,
  range: { from: number; to: number },
): ScheduleUsageSummary {
  const runsInRange = (runs ?? []).filter((run) => {
    const startedAt = run.startedAt ?? run.createdAt;
    return startedAt >= range.from && startedAt <= range.to;
  });

  return {
    scheduleId,
    runCount: runsInRange.length,
    totalEstimatedCostUsd: runsInRange.reduce((total, run) => {
      const cost = run.estimatedCostUsd;
      return typeof cost === "number" && Number.isFinite(cost)
        ? total + cost
        : total;
    }, 0),
    eventCount: 0,
  };
}
