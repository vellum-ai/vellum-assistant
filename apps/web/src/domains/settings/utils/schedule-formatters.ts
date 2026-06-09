import type {
  Schedule,
  ScheduleRun,
  SystemTaskKind,
} from "@/domains/settings/types/schedules";
import type {
  ConsolidationConfigGetResponse,
  HeartbeatConfigGetResponse,
} from "@/generated/daemon/types.gen";
import type { TagTone } from "@vellumai/design-library/components/tag";

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
  maximumFractionDigits: 4,
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
} as const satisfies Record<SystemTaskKind, string>;

export const SYSTEM_TASK_STATS_RUN_LIMIT = 100;

export function shouldShowSystemTaskToggles(
  hasHydrated: boolean,
  flagEnabled: boolean,
): boolean {
  return hasHydrated && flagEnabled;
}

export function systemTaskKindFromUrlId(
  scheduleId: string | undefined,
): SystemTaskKind | null {
  switch (scheduleId) {
    case SYSTEM_TASK_URL_IDS.heartbeat:
      return "heartbeat";
    case SYSTEM_TASK_URL_IDS.consolidation:
      return "consolidation";
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
// Sorting
// ---------------------------------------------------------------------------

export function sortSchedules(schedules: Schedule[]): {
  recurring: Schedule[];
  oneTime: Schedule[];
} {
  const recurring: Schedule[] = [];
  const oneTime: Schedule[] = [];

  for (const s of schedules) {
    if (s.isOneShot) {
      oneTime.push(s);
    } else {
      recurring.push(s);
    }
  }

  recurring.sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity);
  });

  oneTime.sort((a, b) => {
    const aTime = a.lastRunAt ?? a.nextRunAt ?? 0;
    const bTime = b.lastRunAt ?? b.nextRunAt ?? 0;
    return bTime - aTime;
  });

  return { recurring, oneTime };
}

// ---------------------------------------------------------------------------
// Usage summary helpers
// ---------------------------------------------------------------------------

export type ScheduleRowUsage =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; summary: ScheduleUsageSummary };

import type { ScheduleUsageSummary } from "@/domains/settings/types/schedules";
import {
  assistantScheduleUsageSummaryQueryKey,
} from "@/lib/sync/query-tags";
import {
  fetchScheduleUsageSummary,
} from "@/domains/settings/api/schedules";
import { resolveScheduleUsageWindow } from "@/domains/settings/utils/schedule-usage-window";

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
