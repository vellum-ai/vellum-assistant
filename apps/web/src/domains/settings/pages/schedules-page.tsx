import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  BarChart3,
  Calendar,
  ChevronRight,
  Loader2,
  MessageSquare,
  Play,
  Plus,
  Trash2,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";

import { Button } from "@vellum/design-library/components/button";
import { Input } from "@vellum/design-library/components/input";
import { Notice } from "@vellum/design-library/components/notice";
import { PanelItem } from "@vellum/design-library/components/panel-item";
import { Tag } from "@vellum/design-library/components/tag";
import { Toggle } from "@vellum/design-library/components/toggle";
import { toast } from "@vellum/design-library/components/toast";
import { DetailCard } from "@/components/detail-card";
import { assistantsListOptions } from "@/generated/api/@tanstack/react-query.gen";
import {
  deleteSchedule,
  fetchConsolidationConfig,
  fetchHeartbeatConfig,
  fetchHeartbeatRuns,
  fetchScheduleUsageSummary,
  fetchScheduleRuns,
  fetchSchedules,
  runConsolidationNow,
  runHeartbeatNow,
  runScheduleNow,
  toggleSchedule,
  updateSchedule,
} from "@/domains/settings/api/schedules";
import { captureError } from "@/lib/sentry/capture-error";
import {
  assistantScheduleRunsQueryKey,
  assistantSchedulesQueryKey,
} from "@/lib/sync/query-tags";
import { routes } from "@/utils/routes";
import { useEffectiveTimezone } from "@/utils/use-effective-timezone";

import { CreateScheduleModal } from "@/domains/settings/components/create-schedule-modal";
import { resolveScheduleUsageWindow } from "@/domains/settings/utils/schedule-usage-window";

import type {
  ConsolidationConfigGetResponse,
  HeartbeatConfigGetResponse,
} from "@/generated/daemon/types.gen";
import type {
  Schedule,
  ScheduleRun,
  ScheduleUsageSummary,
  SystemTaskKind,
} from "@/domains/settings/types/schedules";
import type { TagTone } from "@vellum/design-library/components/tag";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimestamp(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function formatDuration(ms: number | null | undefined): string {
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

function formatScheduleRunCount(count: number): string {
  const formatted = count.toLocaleString();
  return `${formatted} ${count === 1 ? "run" : "runs"}`;
}

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

function getOpenableScheduleSourceConversationId(
  schedule: Schedule,
): string | null {
  return canOpenScheduleSourceConversation(schedule)
    ? (schedule.createdFromConversationId ?? null)
    : null;
}

function getOpenableScheduleRunConversationId(run: ScheduleRun): string | null {
  return canOpenScheduleRunConversation(run)
    ? (run.conversationId ?? null)
    : null;
}

function hasRunText(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function formatInterval(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 60 && minutes % 60 === 0) {
    return `Every ${minutes / 60} hr`;
  }
  return `Every ${minutes} min`;
}

function heartbeatSubtitle(config: HeartbeatConfigGetResponse): string {
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

function consolidationSubtitle(config: ConsolidationConfigGetResponse): string {
  return formatInterval(config.intervalMs);
}

const MODE_TONE: Record<string, TagTone> = {
  execute: "positive",
  notify: "warning",
  script: "neutral",
};

const SYSTEM_TASK_URL_IDS = {
  heartbeat: "system-heartbeat",
  consolidation: "system-consolidation",
} as const satisfies Record<SystemTaskKind, string>;

function systemTaskKindFromUrlId(
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

function StatusDot({ status }: { status: string | null }) {
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
// Empty state
// ---------------------------------------------------------------------------

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex min-h-[400px] flex-col items-center justify-center rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-lift)] px-6 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--tag-bg-neutral)]">
        <Calendar className="h-6 w-6 text-[var(--content-faint)]" />
      </div>
      <h2 className="mt-4 text-title-small text-[var(--content-default)]">
        No schedules
      </h2>
      <p className="mt-1 text-body-medium-lighter text-[var(--content-quiet)]">
        Scheduled automations will appear here once created. You can create one
        yourself or ask your assistant to set it up.
      </p>
      <div className="mt-4">
        <Button variant="primary" onClick={onCreate}>
          <Plus className="h-4 w-4" />
          Create schedule
        </Button>
      </div>
    </div>
  );
}

function UnknownScheduleState({ onBack }: { onBack: () => void }) {
  return (
    <div className="mx-auto max-w-[940px] space-y-3">
      <Notice tone="error">
        Schedule not found. It may have been deleted or the link may be out of
        date.
      </Notice>
      <Button variant="outlined" onClick={onBack}>
        <ArrowLeft className="h-4 w-4" />
        Back to schedules
      </Button>
    </div>
  );
}

interface RecentRunsCardProps {
  runs: ScheduleRun[] | undefined;
  isLoading: boolean;
  emptyMessage?: string;
}

export function RecentRunsCard({
  runs,
  isLoading,
  emptyMessage = "No runs yet.",
}: RecentRunsCardProps) {
  const navigate = useNavigate();
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);

  return (
    <DetailCard title="Recent runs">
      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-stone-400" />
        </div>
      ) : !runs || runs.length === 0 ? (
        <p className="py-4 text-center text-body-medium-lighter text-[var(--content-tertiary)] italic">
          {emptyMessage}
        </p>
      ) : (
        <div className="divide-y divide-[var(--border-base)]">
          {runs.map((run, index) => {
            const conversationId = getOpenableScheduleRunConversationId(run);
            const hasOutput = hasRunText(run.output);
            const hasError = hasRunText(run.error);
            const hasLocalDetails = !conversationId && (hasOutput || hasError);
            const isExpanded = expandedRunId === run.id;
            const detailsId = `schedule-run-details-${index}`;
            return (
              <div key={run.id}>
                <PanelItem
                  label={
                    <span className="flex min-w-0 flex-1 items-center gap-3">
                      <StatusDot status={run.status} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-body-medium-lighter text-[var(--content-default)]">
                          {formatTimestamp(run.startedAt)}
                        </span>
                        <span className="block text-body-small-default text-[var(--content-tertiary)]">
                          {formatDuration(run.durationMs)} ·{" "}
                          {formatScheduleCost(run.estimatedCostUsd)}
                          {run.status === "error" && run.error && (
                            <span className="ml-2 text-[var(--system-negative-strong)]">
                              {run.error.slice(0, 80)}
                              {run.error.length > 80 ? "…" : ""}
                            </span>
                          )}
                        </span>
                      </span>
                      {conversationId || hasLocalDetails ? (
                        <ChevronRight
                          className={`h-4 w-4 shrink-0 text-[var(--content-tertiary)] transition-transform ${
                            isExpanded ? "rotate-90" : ""
                          }`}
                        />
                      ) : null}
                    </span>
                  }
                  onSelect={
                    conversationId
                      ? () => navigate(routes.conversation(conversationId))
                      : hasLocalDetails
                        ? () =>
                            setExpandedRunId(isExpanded ? null : run.id)
                        : undefined
                  }
                  aria-label={`Run at ${formatTimestamp(run.startedAt)}`}
                  aria-expanded={hasLocalDetails ? isExpanded : undefined}
                  aria-controls={hasLocalDetails ? detailsId : undefined}
                  className="h-auto py-2.5 gap-3 -mx-2 px-2"
                />
                {hasLocalDetails && isExpanded ? (
                  <div id={detailsId} className="px-2 pb-3">
                    <div className="space-y-3 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-3">
                      {hasOutput ? (
                        <div>
                          <div className="mb-1 text-body-small-default text-[var(--content-secondary)]">
                            Output
                          </div>
                          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-body-small-default font-mono text-[var(--content-default)]">
                            {run.output}
                          </pre>
                        </div>
                      ) : null}
                      {hasError ? (
                        <div>
                          <div className="mb-1 text-body-small-default text-[var(--content-secondary)]">
                            Error
                          </div>
                          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-body-small-default font-mono text-[var(--system-negative-strong)]">
                            {run.error}
                          </pre>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </DetailCard>
  );
}

// ---------------------------------------------------------------------------
// Schedule detail view (runs list)
// ---------------------------------------------------------------------------

const DEFAULT_SCRIPT_TIMEOUT_MS = 60_000;
const MIN_SCRIPT_TIMEOUT_SECONDS = 1;
const MAX_SCRIPT_TIMEOUT_SECONDS = 30 * 60;

/**
 * Inline editor for a script schedule's execution timeout. Displays the
 * effective timeout (the per-schedule override, or the default when unset)
 * and lets the guardian change it or reset it back to the default.
 */
function ScriptTimeoutField({
  schedule,
  assistantId,
  onUpdated,
}: {
  schedule: Schedule;
  assistantId: string;
  onUpdated: () => void;
}) {
  const effectiveSeconds = Math.round(
    (schedule.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS) / 1000,
  );
  const [isEditing, setIsEditing] = useState(false);
  const [value, setValue] = useState(String(effectiveSeconds));
  const [isSaving, setIsSaving] = useState(false);

  const startEditing = useCallback(() => {
    setValue(String(effectiveSeconds));
    setIsEditing(true);
  }, [effectiveSeconds]);

  const save = useCallback(
    async (timeoutMs: number | null) => {
      setIsSaving(true);
      try {
        await updateSchedule(assistantId, schedule.id, { timeoutMs });
        setIsEditing(false);
        onUpdated();
      } catch (error) {
        captureError(error, { context: "schedule_update_timeout" });
        toast.error("Failed to update timeout.");
      } finally {
        setIsSaving(false);
      }
    },
    [assistantId, schedule.id, onUpdated],
  );

  const handleSave = useCallback(() => {
    const seconds = Number(value);
    if (
      !Number.isInteger(seconds) ||
      seconds < MIN_SCRIPT_TIMEOUT_SECONDS ||
      seconds > MAX_SCRIPT_TIMEOUT_SECONDS
    ) {
      toast.error(
        `Timeout must be a whole number between ${MIN_SCRIPT_TIMEOUT_SECONDS} and ${MAX_SCRIPT_TIMEOUT_SECONDS} seconds.`,
      );
      return;
    }
    void save(seconds * 1000);
  }, [value, save]);

  if (isEditing) {
    return (
      <div className="flex items-center justify-between gap-2">
        <span className="text-[var(--content-secondary)]">Timeout</span>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={MIN_SCRIPT_TIMEOUT_SECONDS}
            max={MAX_SCRIPT_TIMEOUT_SECONDS}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="w-24"
            aria-label="Timeout in seconds"
          />
          <span className="text-[var(--content-tertiary)]">sec</span>
          <Button size="compact" onClick={handleSave} disabled={isSaving}>
            {isSaving ? "Saving…" : "Save"}
          </Button>
          <Button
            variant="outlined"
            size="compact"
            onClick={() => setIsEditing(false)}
            disabled={isSaving}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[var(--content-secondary)]">Timeout</span>
      <div className="flex items-center gap-2">
        <span>
          {effectiveSeconds}s{schedule.timeoutMs == null ? " (default)" : ""}
        </span>
        <Button variant="outlined" size="compact" onClick={startEditing}>
          Edit
        </Button>
        {schedule.timeoutMs != null && (
          <Button
            variant="outlined"
            size="compact"
            onClick={() => void save(null)}
            disabled={isSaving}
          >
            Reset
          </Button>
        )}
      </div>
    </div>
  );
}

export function ScheduleDetailView({
  schedule,
  assistantId,
  onBack,
  onDeleted,
  onUpdated,
}: {
  schedule: Schedule;
  assistantId: string;
  onBack: () => void;
  onDeleted: () => void;
  onUpdated: () => void;
}) {
  const navigate = useNavigate();

  const {
    data: runs,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: assistantScheduleRunsQueryKey(assistantId, schedule.id),
    queryFn: () => fetchScheduleRuns(assistantId, schedule.id),
    staleTime: 10_000,
  });

  const [isRunning, setIsRunning] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleRunNow = useCallback(async () => {
    setIsRunning(true);
    try {
      await runScheduleNow(assistantId, schedule.id);
      // Wait briefly for the run to complete, then refresh
      setTimeout(() => void refetch(), 1000);
    } catch (error) {
      captureError(error, { context: "schedule_run_now" });
      toast.error("Failed to run schedule.");
    } finally {
      setIsRunning(false);
    }
  }, [assistantId, schedule.id, refetch]);

  const handleDelete = useCallback(async () => {
    setIsDeleting(true);
    try {
      await deleteSchedule(assistantId, schedule.id);
      onDeleted();
    } catch (error) {
      captureError(error, { context: "schedule_delete" });
      toast.error("Failed to delete schedule.");
      setIsDeleting(false);
      setConfirmingDelete(false);
    }
  }, [assistantId, schedule.id, onDeleted]);

  const sourceConversationId =
    getOpenableScheduleSourceConversationId(schedule);

  return (
    <div className="mx-auto max-w-[940px] space-y-4">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1.5 text-body-medium-lighter text-[var(--content-secondary)] hover:text-[var(--content-default)] transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to schedules
      </button>

      <DetailCard
        title={schedule.name}
        subtitle={schedule.description ?? undefined}
        accessory={
          <div className="flex items-center gap-2">
            <Tag tone={MODE_TONE[schedule.mode] ?? "neutral"}>
              {schedule.mode}
            </Tag>
            <Button
              variant="outlined"
              size="compact"
              leftIcon={<BarChart3 className="h-3.5 w-3.5" />}
              onClick={() =>
                navigate(routes.logs.usageForSchedule(schedule.id))
              }
            >
              View usage
            </Button>
            {sourceConversationId ? (
              <Button
                variant="outlined"
                size="compact"
                leftIcon={<MessageSquare className="h-3.5 w-3.5" />}
                onClick={() =>
                  navigate(routes.conversation(sourceConversationId))
                }
              >
                Source
              </Button>
            ) : null}
            {schedule.mode === "script" && (
              <Button
                variant="outlined"
                size="compact"
                leftIcon={
                  isRunning ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Play className="h-3.5 w-3.5" />
                  )
                }
                onClick={handleRunNow}
                disabled={isRunning}
              >
                {isRunning ? "Running…" : "Run now"}
              </Button>
            )}
          </div>
        }
      >
        <div className="space-y-2 text-body-medium-lighter">
          {schedule.mode === "script" && schedule.script && (
            <div>
              <span className="text-[var(--content-secondary)] text-body-small-default">
                Command
              </span>
              <pre className="mt-1 rounded-md bg-[var(--surface-sunken)] p-2 text-body-small-default font-mono text-[var(--content-default)] whitespace-pre-wrap break-all">
                {schedule.script}
              </pre>
            </div>
          )}
          {schedule.mode === "script" && (
            <ScriptTimeoutField
              schedule={schedule}
              assistantId={assistantId}
              onUpdated={onUpdated}
            />
          )}
          <div className="flex items-center justify-between">
            <span className="text-[var(--content-secondary)]">Status</span>
            <span>{schedule.enabled ? "Enabled" : "Disabled"}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[var(--content-secondary)]">Next run</span>
            <span>{formatTimestamp(schedule.nextRunAt)}</span>
          </div>
          {schedule.lastRunAt && (
            <div className="flex items-center justify-between">
              <span className="text-[var(--content-secondary)]">Last run</span>
              <span className="flex items-center gap-2">
                <StatusDot status={schedule.lastStatus} />
                {formatTimestamp(schedule.lastRunAt)}
              </span>
            </div>
          )}
        </div>
      </DetailCard>

      <RecentRunsCard
        runs={runs}
        isLoading={isLoading}
      />

      <DetailCard title="Danger zone">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-body-medium-default text-[var(--content-default)]">
              Delete this schedule
            </p>
            <p className="text-body-small-default text-[var(--content-tertiary)]">
              Permanently removes the schedule and all its run history. This
              cannot be undone.
            </p>
          </div>
          {!confirmingDelete ? (
            <Button
              variant="dangerOutline"
              size="compact"
              leftIcon={<Trash2 className="h-3.5 w-3.5" />}
              onClick={() => setConfirmingDelete(true)}
            >
              Delete
            </Button>
          ) : (
            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="ghost"
                size="compact"
                onClick={() => setConfirmingDelete(false)}
                disabled={isDeleting}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                size="compact"
                onClick={() => void handleDelete()}
                disabled={isDeleting}
              >
                {isDeleting ? "Deleting…" : "Yes, delete"}
              </Button>
            </div>
          )}
        </div>
      </DetailCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Schedule list row
// ---------------------------------------------------------------------------

export type ScheduleRowUsage =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; summary: ScheduleUsageSummary };

function zeroScheduleUsageSummary(scheduleId: string): ScheduleUsageSummary {
  return {
    scheduleId,
    runCount: 0,
    totalEstimatedCostUsd: 0,
    eventCount: 0,
  };
}

function ScheduleUsageStats({
  scheduleName,
  usage,
  onOpenUsage,
}: {
  scheduleName: string;
  usage: ScheduleRowUsage;
  onOpenUsage: () => void;
}) {
  if (usage.status === "loading") {
    return (
      <div
        aria-label="Loading schedule usage"
        className="flex w-[136px] shrink-0 items-center justify-end gap-3"
      >
        <span className="h-8 w-14 animate-pulse rounded bg-[var(--surface-muted)]" />
        <span className="h-8 w-14 animate-pulse rounded bg-[var(--surface-muted)]" />
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

  return (
    <div className="flex w-[136px] shrink-0 items-center justify-end gap-3 text-right">
      <button
        type="button"
        onClick={onOpenUsage}
        aria-label={`View usage for ${scheduleName}`}
        className="min-w-[54px] cursor-pointer rounded px-1 py-0.5 text-right transition-colors hover:bg-[var(--surface-hover)]"
      >
        <span className="block text-label-small-default text-[var(--content-tertiary)]">
          Cost
        </span>
        <span className="block text-body-small-default text-[var(--content-default)]">
          {cost}
        </span>
      </button>
      <span
        aria-label={`Runs for ${scheduleName} in the last 7 days: ${runs}`}
        className="block min-w-[54px] px-1 py-0.5"
      >
        <span className="block text-label-small-default text-[var(--content-tertiary)]">
          Runs
        </span>
        <span className="block text-body-small-default text-[var(--content-default)]">
          {runs}
        </span>
      </span>
    </div>
  );
}

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
    <div className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0 [&+&]:border-t [&+&]:border-[var(--border-base)]">
      <button
        type="button"
        onClick={onClick}
        className="min-w-0 flex-1 text-left"
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

// ---------------------------------------------------------------------------
// Sorting helpers
// ---------------------------------------------------------------------------

function sortSchedules(schedules: Schedule[]): {
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

  // Recurring: enabled sorted by nextRunAt ascending, then disabled at the end
  recurring.sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity);
  });

  // One-time: most recent first (by lastRunAt descending, then nextRunAt descending)
  oneTime.sort((a, b) => {
    const aTime = a.lastRunAt ?? a.nextRunAt ?? 0;
    const bTime = b.lastRunAt ?? b.nextRunAt ?? 0;
    return bTime - aTime;
  });

  return { recurring, oneTime };
}

// ---------------------------------------------------------------------------
// System task detail view (runs list)
// ---------------------------------------------------------------------------

interface SystemTaskDetailViewProps {
  kind: SystemTaskKind;
  assistantId: string;
  name: string;
  subtitle: string;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  isRunning: boolean;
  onBack: () => void;
  onRunNow: () => void;
}

function SystemTaskDetailView({
  kind,
  assistantId,
  name,
  subtitle,
  enabled,
  nextRunAt,
  lastRunAt,
  isRunning,
  onBack,
  onRunNow,
}: SystemTaskDetailViewProps) {
  const { data: runs, isLoading } = useQuery({
    queryKey: ["system-task-runs", assistantId, kind],
    queryFn: () =>
      kind === "heartbeat" ? fetchHeartbeatRuns(assistantId) : [],
    enabled: kind === "heartbeat",
    staleTime: 10_000,
  });

  return (
    <div className="mx-auto max-w-[940px] space-y-4">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1.5 text-body-medium-lighter text-[var(--content-secondary)] hover:text-[var(--content-default)] transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to schedules
      </button>

      <DetailCard
        title={name}
        subtitle={subtitle}
        accessory={
          <div className="flex items-center gap-2">
            <Tag tone="neutral">system</Tag>
            <Button
              variant="outlined"
              size="compact"
              leftIcon={
                isRunning ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )
              }
              onClick={onRunNow}
              disabled={isRunning}
            >
              {isRunning ? "Running…" : "Run now"}
            </Button>
          </div>
        }
      >
        <div className="space-y-2 text-body-medium-lighter">
          <div className="flex items-center justify-between">
            <span className="text-[var(--content-secondary)]">Status</span>
            <span>{enabled ? "Enabled" : "Disabled"}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[var(--content-secondary)]">Next run</span>
            <span>{formatTimestamp(nextRunAt)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[var(--content-secondary)]">Last run</span>
            <span>{formatTimestamp(lastRunAt)}</span>
          </div>
        </div>
      </DetailCard>

      <RecentRunsCard
        runs={kind === "heartbeat" ? runs : []}
        isLoading={kind === "heartbeat" ? isLoading : false}
        emptyMessage={
          kind === "heartbeat"
            ? "No runs yet."
            : "Run history is not available for this system job yet."
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// System task rows
// ---------------------------------------------------------------------------

interface SystemTaskRowProps {
  name: string;
  subtitle: string;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  isRunning: boolean;
  onClick: () => void;
  onRunNow: () => void;
}

function SystemTaskRow({
  name,
  subtitle,
  enabled,
  nextRunAt,
  lastRunAt,
  isRunning,
  onClick,
  onRunNow,
}: SystemTaskRowProps) {
  return (
    <div className="flex items-center gap-3 py-3 first:pt-0 last:pb-0 [&+&]:border-t [&+&]:border-[var(--border-base)]">
      <button
        type="button"
        onClick={onClick}
        className="min-w-0 flex-1 text-left"
      >
        <div className="flex items-center gap-2">
          <span className="truncate text-body-medium-default text-[var(--content-default)]">
            {name}
          </span>
          <Tag tone="neutral">system</Tag>
        </div>
        <div className="mt-0.5 text-body-small-default text-[var(--content-tertiary)]">
          {subtitle}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-body-small-default text-[var(--content-tertiary)]">
          {nextRunAt ? <span>Next: {formatTimestamp(nextRunAt)}</span> : null}
          {lastRunAt ? <span>Last: {formatTimestamp(lastRunAt)}</span> : null}
        </div>
      </button>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          variant="ghost"
          size="compact"
          leftIcon={
            isRunning ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )
          }
          onClick={(event) => {
            event.stopPropagation();
            onRunNow();
          }}
          disabled={isRunning}
        >
          {isRunning ? "Running…" : "Run now"}
        </Button>
        <span
          className="h-2 w-2 rounded-full"
          style={{
            backgroundColor: enabled
              ? "var(--system-positive-strong)"
              : "var(--content-disabled)",
          }}
          aria-label={enabled ? "enabled" : "disabled"}
        />
        <ChevronRight
          className="h-4 w-4 text-[var(--content-tertiary)] cursor-pointer"
          onClick={onClick}
        />
      </div>
    </div>
  );
}

interface SystemTasksSectionProps {
  heartbeatConfig: HeartbeatConfigGetResponse | undefined;
  consolidationConfig: ConsolidationConfigGetResponse | undefined;
  isLoading: boolean;
  hasError: boolean;
  onRetry: () => void;
  onRunHeartbeatNow: () => void;
  onRunConsolidationNow: () => void;
  onSelectHeartbeat: () => void;
  onSelectConsolidation: () => void;
  isHeartbeatRunning: boolean;
  isConsolidationRunning: boolean;
}

function SystemTasksSection({
  heartbeatConfig,
  consolidationConfig,
  isLoading,
  hasError,
  onRetry,
  onRunHeartbeatNow,
  onRunConsolidationNow,
  onSelectHeartbeat,
  onSelectConsolidation,
  isHeartbeatRunning,
  isConsolidationRunning,
}: SystemTasksSectionProps) {
  const showHeartbeat = heartbeatConfig != null;
  const showConsolidation = consolidationConfig?.available === true;

  if (!isLoading && !hasError && !showHeartbeat && !showConsolidation) {
    return null;
  }

  return (
    <DetailCard
      title="System"
      subtitle="Built-in jobs managed by the assistant runtime."
    >
      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-stone-400" />
        </div>
      ) : hasError && !showHeartbeat && !showConsolidation ? (
        <Notice tone="error">
          Failed to load system jobs.{" "}
          <button
            type="button"
            onClick={onRetry}
            className="cursor-pointer underline hover:no-underline"
          >
            Retry
          </button>
        </Notice>
      ) : (
        <div>
          {showHeartbeat ? (
            <SystemTaskRow
              name="Heartbeat"
              subtitle={heartbeatSubtitle(heartbeatConfig)}
              enabled={heartbeatConfig.enabled}
              nextRunAt={heartbeatConfig.nextRunAt}
              lastRunAt={heartbeatConfig.lastRunAt}
              isRunning={isHeartbeatRunning}
              onClick={onSelectHeartbeat}
              onRunNow={onRunHeartbeatNow}
            />
          ) : null}
          {showConsolidation ? (
            <SystemTaskRow
              name="Consolidation"
              subtitle={consolidationSubtitle(consolidationConfig)}
              enabled={consolidationConfig.enabled}
              nextRunAt={consolidationConfig.nextRunAt}
              lastRunAt={consolidationConfig.lastRunAt}
              isRunning={isConsolidationRunning}
              onClick={onSelectConsolidation}
              onRunNow={onRunConsolidationNow}
            />
          ) : null}
          {hasError ? (
            <div className="pt-3 first:pt-0">
              <Notice tone="error">
                Some system jobs failed to load.{" "}
                <button
                  type="button"
                  onClick={onRetry}
                  className="cursor-pointer underline hover:no-underline"
                >
                  Retry
                </button>
              </Notice>
            </div>
          ) : null}
        </div>
      )}
    </DetailCard>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function SchedulesPage() {
  const navigate = useNavigate();
  const { scheduleId } = useParams<{ scheduleId?: string }>();
  const tz = useEffectiveTimezone();
  const {
    data: assistantList,
    isLoading: isAssistantLoading,
    isError: isAssistantError,
    refetch: refetchAssistants,
  } = useQuery(assistantsListOptions());
  const assistantId = assistantList?.results?.[0]?.id;

  const {
    data: schedules,
    isLoading: isSchedulesLoading,
    isError: isSchedulesError,
    refetch,
  } = useQuery({
    queryKey: assistantSchedulesQueryKey(assistantId),
    queryFn: () => fetchSchedules(assistantId!),
    enabled: !!assistantId,
    staleTime: 10_000,
  });

  const usageWindow = useMemo(() => resolveScheduleUsageWindow(tz), [tz]);
  const {
    data: usageSummaries,
    isLoading: isUsageSummaryLoading,
    isError: isUsageSummaryError,
  } = useQuery({
    queryKey: [
      "schedule-usage-summary",
      assistantId,
      usageWindow.from,
      usageWindow.to,
    ],
    queryFn: () => fetchScheduleUsageSummary(assistantId!, usageWindow),
    enabled: !!assistantId,
    staleTime: 10_000,
  });

  const {
    data: heartbeatConfig,
    isLoading: isHeartbeatLoading,
    isError: isHeartbeatError,
    refetch: refetchHeartbeat,
  } = useQuery({
    queryKey: ["heartbeat-config", assistantId],
    queryFn: () => fetchHeartbeatConfig(assistantId!),
    enabled: !!assistantId,
    staleTime: 10_000,
  });

  const {
    data: consolidationConfig,
    isLoading: isConsolidationLoading,
    isError: isConsolidationError,
    refetch: refetchConsolidation,
  } = useQuery({
    queryKey: ["consolidation-config", assistantId],
    queryFn: () => fetchConsolidationConfig(assistantId!),
    enabled: !!assistantId,
    staleTime: 10_000,
  });

  const selectedSystemTask = systemTaskKindFromUrlId(scheduleId);
  const [createOpen, setCreateOpen] = useState(false);
  const [isHeartbeatRunning, setIsHeartbeatRunning] = useState(false);
  const [isConsolidationRunning, setIsConsolidationRunning] = useState(false);
  const selectedSchedule = useMemo(
    () =>
      scheduleId && !selectedSystemTask
        ? (schedules?.find((schedule) => schedule.id === scheduleId) ??
          null)
        : null,
    [schedules, scheduleId, selectedSystemTask],
  );
  const usageSummaryByScheduleId = useMemo(
    () =>
      new Map(
        (usageSummaries ?? []).map((summary) => [
          summary.scheduleId,
          summary,
        ]),
      ),
    [usageSummaries],
  );

  const usageForSchedule = useCallback(
    (scheduleId: string): ScheduleRowUsage => {
      if (isUsageSummaryLoading) {
        return { status: "loading" };
      }
      if (isUsageSummaryError) {
        return { status: "error" };
      }
      return {
        status: "ready",
        summary:
          usageSummaryByScheduleId.get(scheduleId) ??
          zeroScheduleUsageSummary(scheduleId),
      };
    },
    [isUsageSummaryError, isUsageSummaryLoading, usageSummaryByScheduleId],
  );

  const navigateToSchedules = useCallback(() => {
    navigate(routes.settings.schedules);
  }, [navigate]);

  const navigateToSchedule = useCallback(
    (id: string) => {
      navigate(routes.settings.schedule(id));
    },
    [navigate],
  );

  const handleCreated = useCallback(() => {
    setCreateOpen(false);
    void refetch();
    toast.success("Schedule created.");
  }, [refetch]);

  const handleToggle = useCallback(
    async (scheduleId: string, enabled: boolean) => {
      if (!assistantId) return;
      try {
        await toggleSchedule(assistantId, scheduleId, enabled);
        void refetch();
      } catch (error) {
        captureError(error, { context: "schedule_toggle" });
        toast.error("Failed to toggle schedule.");
      }
    },
    [assistantId, refetch],
  );

  const isSystemLoading = isHeartbeatLoading || isConsolidationLoading;
  const hasSystemError = isHeartbeatError || isConsolidationError;
  const hasAnySystemTask =
    heartbeatConfig != null || consolidationConfig?.available === true;

  const refetchSystemTasks = useCallback(() => {
    void refetchHeartbeat();
    void refetchConsolidation();
  }, [refetchHeartbeat, refetchConsolidation]);

  const handleRunHeartbeatNow = useCallback(async () => {
    if (!assistantId) return;
    setIsHeartbeatRunning(true);
    try {
      const result = await runHeartbeatNow(assistantId);
      void refetchHeartbeat();
      if (result.ran) {
        toast.success("Heartbeat started.");
      } else {
        toast.info("Heartbeat skipped.");
      }
    } catch (error) {
      captureError(error, { context: "heartbeat_run_now" });
      toast.error("Failed to run heartbeat.");
    } finally {
      setIsHeartbeatRunning(false);
    }
  }, [assistantId, refetchHeartbeat]);

  const handleRunConsolidationNow = useCallback(async () => {
    if (!assistantId) return;
    setIsConsolidationRunning(true);
    try {
      const result = await runConsolidationNow(assistantId);
      void refetchConsolidation();
      if (result.ran) {
        toast.success("Consolidation queued.");
      } else {
        toast.info("Consolidation already queued or running.");
      }
    } catch (error) {
      captureError(error, { context: "consolidation_run_now" });
      toast.error("Failed to run consolidation.");
    } finally {
      setIsConsolidationRunning(false);
    }
  }, [assistantId, refetchConsolidation]);

  const isLoading = isAssistantLoading || isSchedulesLoading;
  const isSelectedSystemTaskLoading =
    (selectedSystemTask === "heartbeat" && isHeartbeatLoading) ||
    (selectedSystemTask === "consolidation" && isConsolidationLoading);
  const isSelectedSystemTaskError =
    (selectedSystemTask === "heartbeat" && isHeartbeatError) ||
    (selectedSystemTask === "consolidation" && isConsolidationError);

  if (selectedSystemTask === "heartbeat" && assistantId && heartbeatConfig) {
    return (
      <SystemTaskDetailView
        key="heartbeat"
        kind="heartbeat"
        assistantId={assistantId}
        name="Heartbeat"
        subtitle={heartbeatSubtitle(heartbeatConfig)}
        enabled={heartbeatConfig.enabled}
        nextRunAt={heartbeatConfig.nextRunAt}
        lastRunAt={heartbeatConfig.lastRunAt}
        isRunning={isHeartbeatRunning}
        onBack={navigateToSchedules}
        onRunNow={handleRunHeartbeatNow}
      />
    );
  }

  if (
    selectedSystemTask === "consolidation" &&
    assistantId &&
    consolidationConfig?.available === true
  ) {
    return (
      <SystemTaskDetailView
        key="consolidation"
        kind="consolidation"
        assistantId={assistantId}
        name="Consolidation"
        subtitle={consolidationSubtitle(consolidationConfig)}
        enabled={consolidationConfig.enabled}
        nextRunAt={consolidationConfig.nextRunAt}
        lastRunAt={consolidationConfig.lastRunAt}
        isRunning={isConsolidationRunning}
        onBack={navigateToSchedules}
        onRunNow={handleRunConsolidationNow}
      />
    );
  }

  if (selectedSchedule && assistantId) {
    return (
      <ScheduleDetailView
        key={selectedSchedule.id}
        schedule={selectedSchedule}
        assistantId={assistantId}
        onBack={navigateToSchedules}
        onDeleted={() => {
          navigateToSchedules();
          void refetch();
        }}
        onUpdated={() => void refetch()}
      />
    );
  }

  if (isLoading || isSelectedSystemTaskLoading) {
    return (
      <div className="mx-auto max-w-[940px]">
        <div className="flex min-h-[400px] items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-stone-400" />
        </div>
      </div>
    );
  }

  if ((isAssistantError && !assistantId) || (isSchedulesError && !schedules)) {
    return (
      <div className="mx-auto max-w-[940px]">
        <Notice tone="error">
          Failed to load schedules.{" "}
          <button
            type="button"
            onClick={() => {
              if (isAssistantError) {
                void refetchAssistants();
              } else {
                void refetch();
              }
            }}
            className="cursor-pointer underline hover:no-underline"
          >
            Retry
          </button>
        </Notice>
      </div>
    );
  }

  if (isSelectedSystemTaskError) {
    return (
      <div className="mx-auto max-w-[940px] space-y-3">
        <Notice tone="error">
          Failed to load{" "}
          {selectedSystemTask === "heartbeat" ? "heartbeat" : "consolidation"}{" "}
          schedule.{" "}
          <button
            type="button"
            onClick={() => {
              if (selectedSystemTask === "heartbeat") {
                void refetchHeartbeat();
              } else {
                void refetchConsolidation();
              }
            }}
            className="cursor-pointer underline hover:no-underline"
          >
            Retry
          </button>
        </Notice>
        <Button variant="outlined" onClick={navigateToSchedules}>
          <ArrowLeft className="h-4 w-4" />
          Back to schedules
        </Button>
      </div>
    );
  }

  if (scheduleId != null) {
    return <UnknownScheduleState onBack={navigateToSchedules} />;
  }

  if (
    !schedules ||
    (schedules.length === 0 &&
      !hasAnySystemTask &&
      !isSystemLoading &&
      !hasSystemError)
  ) {
    return (
      <div className="mx-auto max-w-[940px]">
        <EmptyState onCreate={() => setCreateOpen(true)} />
        {assistantId ? (
          <CreateScheduleModal
            isOpen={createOpen}
            assistantId={assistantId}
            onClose={() => setCreateOpen(false)}
            onCreated={handleCreated}
          />
        ) : null}
      </div>
    );
  }

  const { recurring, oneTime } = sortSchedules(schedules);

  return (
    <div className="mx-auto max-w-[940px] space-y-4">
      <div className="flex items-center justify-end">
        <Button variant="primary" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          New schedule
        </Button>
      </div>

      {isUsageSummaryError ? (
        <Notice tone="warning" className="py-2 text-body-small-default">
          Schedule usage stats are unavailable right now.
        </Notice>
      ) : null}

      {recurring.length > 0 && (
        <DetailCard
          title="Schedules"
          subtitle="Recurring automations managed by your assistant."
        >
          <div>
            {recurring.map((schedule) => (
              <ScheduleRow
                key={schedule.id}
                schedule={schedule}
                usage={usageForSchedule(schedule.id)}
                onClick={() => navigateToSchedule(schedule.id)}
                onToggle={(enabled) => void handleToggle(schedule.id, enabled)}
                onOpenUsage={() =>
                  navigate(routes.logs.usageForSchedule(schedule.id))
                }
              />
            ))}
          </div>
        </DetailCard>
      )}

      <SystemTasksSection
        heartbeatConfig={heartbeatConfig}
        consolidationConfig={consolidationConfig}
        isLoading={isSystemLoading}
        hasError={hasSystemError}
        onRetry={refetchSystemTasks}
        onRunHeartbeatNow={handleRunHeartbeatNow}
        onRunConsolidationNow={handleRunConsolidationNow}
        onSelectHeartbeat={() =>
          navigateToSchedule(SYSTEM_TASK_URL_IDS.heartbeat)
        }
        onSelectConsolidation={() =>
          navigateToSchedule(SYSTEM_TASK_URL_IDS.consolidation)
        }
        isHeartbeatRunning={isHeartbeatRunning}
        isConsolidationRunning={isConsolidationRunning}
      />

      {oneTime.length > 0 && (
        <DetailCard
          title="One-time"
          subtitle="One-shot automations that run once at a scheduled time."
        >
          <div>
            {oneTime.map((schedule) => (
              <ScheduleRow
                key={schedule.id}
                schedule={schedule}
                usage={usageForSchedule(schedule.id)}
                onClick={() => navigateToSchedule(schedule.id)}
                onToggle={(enabled) => void handleToggle(schedule.id, enabled)}
                onOpenUsage={() =>
                  navigate(routes.logs.usageForSchedule(schedule.id))
                }
              />
            ))}
          </div>
        </DetailCard>
      )}

      {assistantId ? (
        <CreateScheduleModal
          isOpen={createOpen}
          assistantId={assistantId}
          onClose={() => setCreateOpen(false)}
          onCreated={handleCreated}
        />
      ) : null}
    </div>
  );
}
