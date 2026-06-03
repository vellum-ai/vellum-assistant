import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Calendar,
  ChevronRight,
  Loader2,
  Play,
  Plus,
  Trash2,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

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

import { CreateScheduleModal } from "@/domains/settings/components/create-schedule-modal";

import type {
  ConsolidationConfigGetResponse,
  HeartbeatConfigGetResponse,
} from "@/generated/daemon/types.gen";
import type {
  Schedule,
  ScheduleRun,
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

// ---------------------------------------------------------------------------
// Run log view
// ---------------------------------------------------------------------------

function RunLogView({ run, onBack }: { run: ScheduleRun; onBack: () => void }) {
  return (
    <div className="mx-auto max-w-[940px] space-y-4">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1.5 text-body-medium-lighter text-[var(--content-secondary)] hover:text-[var(--content-default)] transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to runs
      </button>

      <DetailCard title="Run details">
        <div className="space-y-3 text-body-medium-lighter">
          <div className="flex items-center justify-between">
            <span className="text-[var(--content-secondary)]">Status</span>
            <span className="flex items-center gap-2">
              <StatusDot status={run.status} />
              {run.status}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[var(--content-secondary)]">Started</span>
            <span>{formatTimestamp(run.startedAt)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[var(--content-secondary)]">Duration</span>
            <span>{formatDuration(run.durationMs)}</span>
          </div>
        </div>
      </DetailCard>

      {run.output && (
        <DetailCard title="Output">
          <pre className="max-h-80 overflow-auto rounded-md bg-[var(--surface-sunken)] p-3 text-body-small-default font-mono text-[var(--content-default)] whitespace-pre-wrap break-all">
            {run.output}
          </pre>
        </DetailCard>
      )}

      {run.error && (
        <DetailCard title="Error">
          <pre className="max-h-80 overflow-auto rounded-md bg-[var(--system-negative-weak)] p-3 text-body-small-default font-mono text-[var(--system-negative-strong)] whitespace-pre-wrap break-all">
            {run.error}
          </pre>
        </DetailCard>
      )}

      {!run.output && !run.error && (
        <DetailCard>
          <p className="text-body-medium-lighter text-[var(--content-tertiary)] italic">
            No output or errors captured for this run.
          </p>
        </DetailCard>
      )}
    </div>
  );
}

interface RecentRunsCardProps {
  runs: ScheduleRun[] | undefined;
  isLoading: boolean;
  onSelectRun: (run: ScheduleRun) => void;
  emptyMessage?: string;
}

function RecentRunsCard({
  runs,
  isLoading,
  onSelectRun,
  emptyMessage = "No runs yet.",
}: RecentRunsCardProps) {
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
          {runs.map((run) => (
            <PanelItem
              key={run.id}
              asChild
              label={`Run at ${formatTimestamp(run.startedAt)}`}
              className="h-auto py-2.5 gap-3 -mx-2 px-2"
            >
              <button type="button" onClick={() => onSelectRun(run)}>
                <span className="flex min-w-0 flex-1 items-center gap-3">
                  <StatusDot status={run.status} />
                  <div className="min-w-0 flex-1">
                    <div className="text-body-medium-lighter text-[var(--content-default)]">
                      {formatTimestamp(run.startedAt)}
                    </div>
                    <div className="text-body-small-default text-[var(--content-tertiary)]">
                      {formatDuration(run.durationMs)}
                      {run.status === "error" && run.error && (
                        <span className="ml-2 text-[var(--system-negative-strong)]">
                          {run.error.slice(0, 80)}
                          {run.error.length > 80 ? "…" : ""}
                        </span>
                      )}
                    </div>
                  </div>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-[var(--content-tertiary)]" />
              </button>
            </PanelItem>
          ))}
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
  const [selectedRun, setSelectedRun] = useState<ScheduleRun | null>(null);

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

  if (selectedRun) {
    return <RunLogView run={selectedRun} onBack={() => setSelectedRun(null)} />;
  }

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
        onSelectRun={setSelectedRun}
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

function ScheduleRow({
  schedule,
  onClick,
  onToggle,
}: {
  schedule: Schedule;
  onClick: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-3 py-3 first:pt-0 last:pb-0 [&+&]:border-t [&+&]:border-[var(--border-base)]">
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
        <Toggle
          checked={schedule.enabled}
          onChange={onToggle}
          aria-label={`Toggle ${schedule.name}`}
        />
        <ChevronRight
          className="h-4 w-4 text-[var(--content-tertiary)] cursor-pointer"
          onClick={onClick}
        />
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
  const [selectedRun, setSelectedRun] = useState<ScheduleRun | null>(null);

  const { data: runs, isLoading } = useQuery({
    queryKey: ["system-task-runs", assistantId, kind],
    queryFn: () =>
      kind === "heartbeat" ? fetchHeartbeatRuns(assistantId) : [],
    enabled: kind === "heartbeat",
    staleTime: 10_000,
  });

  if (selectedRun) {
    return <RunLogView run={selectedRun} onBack={() => setSelectedRun(null)} />;
  }

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
        onSelectRun={setSelectedRun}
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

  const [selectedScheduleId, setSelectedScheduleId] = useState<string | null>(
    null,
  );
  const [selectedSystemTask, setSelectedSystemTask] =
    useState<SystemTaskKind | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [isHeartbeatRunning, setIsHeartbeatRunning] = useState(false);
  const [isConsolidationRunning, setIsConsolidationRunning] = useState(false);
  const selectedSchedule = useMemo(
    () =>
      selectedScheduleId
        ? (schedules?.find((schedule) => schedule.id === selectedScheduleId) ??
          null)
        : null,
    [schedules, selectedScheduleId],
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

  if (selectedSystemTask === "heartbeat" && assistantId && heartbeatConfig) {
    return (
      <SystemTaskDetailView
        kind="heartbeat"
        assistantId={assistantId}
        name="Heartbeat"
        subtitle={heartbeatSubtitle(heartbeatConfig)}
        enabled={heartbeatConfig.enabled}
        nextRunAt={heartbeatConfig.nextRunAt}
        lastRunAt={heartbeatConfig.lastRunAt}
        isRunning={isHeartbeatRunning}
        onBack={() => setSelectedSystemTask(null)}
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
        kind="consolidation"
        assistantId={assistantId}
        name="Consolidation"
        subtitle={consolidationSubtitle(consolidationConfig)}
        enabled={consolidationConfig.enabled}
        nextRunAt={consolidationConfig.nextRunAt}
        lastRunAt={consolidationConfig.lastRunAt}
        isRunning={isConsolidationRunning}
        onBack={() => setSelectedSystemTask(null)}
        onRunNow={handleRunConsolidationNow}
      />
    );
  }

  if (selectedSchedule && assistantId) {
    return (
      <ScheduleDetailView
        schedule={selectedSchedule}
        assistantId={assistantId}
        onBack={() => setSelectedScheduleId(null)}
        onDeleted={() => {
          setSelectedScheduleId(null);
          void refetch();
        }}
        onUpdated={() => void refetch()}
      />
    );
  }

  if (isLoading) {
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
                onClick={() => setSelectedScheduleId(schedule.id)}
                onToggle={(enabled) => void handleToggle(schedule.id, enabled)}
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
        onSelectHeartbeat={() => setSelectedSystemTask("heartbeat")}
        onSelectConsolidation={() => setSelectedSystemTask("consolidation")}
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
                onClick={() => setSelectedScheduleId(schedule.id)}
                onToggle={(enabled) => void handleToggle(schedule.id, enabled)}
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
