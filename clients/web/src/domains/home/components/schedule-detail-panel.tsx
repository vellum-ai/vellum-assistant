import type { ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";
import {
  BarChart3,
  ChevronRight,
  Coins,
  Loader2,
  Repeat,
  Trash2,
  X,
} from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";

import {
  deleteSchedule,
  fetchScheduleRuns,
  runScheduleNow,
} from "@/domains/settings/api/schedules";
import { StatusDot } from "@/domains/settings/components/schedule-shared-ui";
import {
  formatDuration,
  formatScheduleCost,
  formatScheduleRunCount,
  formatTimestamp,
  getOpenableScheduleRunConversationId,
  hasRunText,
  type ScheduleRowUsage,
} from "@/domains/settings/utils/schedule-formatters";
import { captureError } from "@/lib/sentry/capture-error";
import { schedulesByIdRunsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { routes } from "@/utils/routes";
import { Button, Typography, cn } from "@vellumai/design-library";
import { toast } from "@vellumai/design-library/components/toast";

import type { Schedule, ScheduleRun } from "@/domains/settings/types/schedules";

function SectionLabel({ children }: { children: string }) {
  return (
    <Typography
      variant="label-small-default"
      as="div"
      className="mb-2 uppercase tracking-wider text-[var(--content-tertiary)]"
    >
      {children}
    </Typography>
  );
}

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <span className="text-body-medium-lighter text-[var(--content-secondary)]">
        {label}
      </span>
      <span className="min-w-0 text-right text-body-medium-lighter text-[var(--content-default)]">
        {value}
      </span>
    </div>
  );
}

function StatCard({
  icon,
  value,
  label,
}: {
  icon: ReactNode;
  value: string;
  label: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-[var(--border-base)] bg-[var(--surface-lift)] p-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--surface-sunken)] text-[var(--content-secondary)]">
        {icon}
      </span>
      <div className="min-w-0">
        <div className="truncate text-body-large-default text-[var(--content-default)]">
          {value}
        </div>
        <div className="text-body-small-default text-[var(--content-tertiary)]">
          {label}
        </div>
      </div>
    </div>
  );
}

function StatCards({ usage }: { usage: ScheduleRowUsage }) {
  if (usage.status === "loading") {
    return (
      <div className="grid grid-cols-2 gap-3 pt-2">
        {Array.from({ length: 2 }, (_, i) => (
          <div
            key={i}
            className="h-[60px] animate-pulse rounded-lg bg-[var(--surface-muted)]"
          />
        ))}
      </div>
    );
  }
  if (usage.status === "error") {
    return null;
  }
  return (
    <div className="grid grid-cols-2 gap-3 pt-2">
      <StatCard
        icon={<Coins className="h-4 w-4" />}
        value={formatScheduleCost(usage.summary.totalEstimatedCostUsd)}
        label="7 Day Cost"
      />
      <StatCard
        icon={<Repeat className="h-4 w-4" />}
        value={formatScheduleRunCount(usage.summary.runCount)}
        label="7 Day Runs"
      />
    </div>
  );
}

type RunConversation = NonNullable<ScheduleRun["conversations"]>[number];

// A pruned or archived conversation is listed but not navigable. This mirrors
// the legacy `canOpenScheduleRunConversation` rule.
function canOpenRunConversation(c: RunConversation): boolean {
  return c.exists && c.archivedAt == null;
}

function RunRow({
  run,
  index,
  isExpanded,
  disableDirectOpen,
  onOpenConversation,
  onToggleDetails,
}: {
  run: ScheduleRun;
  index: number;
  isExpanded: boolean;
  disableDirectOpen: boolean;
  onOpenConversation: (conversationId: string) => void;
  onToggleDetails: (runId: string) => void;
}) {
  // Older daemons do not send `conversations`, so the scalar pointer is
  // wrapped in the same shape here. Newer daemons fold that pointer into the
  // array themselves.
  const legacyOpenId = getOpenableScheduleRunConversationId(run);
  const conversations =
    run.conversations ??
    (legacyOpenId
      ? [{ id: legacyOpenId, title: null, exists: true, archivedAt: null }]
      : []);
  const hasOutput = hasRunText(run.output);
  const hasError = hasRunText(run.error);
  // Clicking a run with exactly one openable conversation goes straight to
  // it. Script mode disables that shortcut so the row expands instead,
  // keeping stdout and stderr reachable.
  const directOpenId =
    !disableDirectOpen &&
    conversations.length === 1 &&
    canOpenRunConversation(conversations[0])
      ? conversations[0].id
      : null;
  const hasExpand =
    !directOpenId && (conversations.length > 0 || hasOutput || hasError);
  const detailsId = `schedule-run-details-${index}`;
  const isInteractive = !!directOpenId || hasExpand;

  const body = (
    <>
      <StatusDot status={run.status} />
      <div className="min-w-0 flex-1">
        <div className="text-body-medium-lighter text-[var(--content-default)]">
          {formatTimestamp(run.startedAt)}
        </div>
        <div className="text-body-small-default text-[var(--content-tertiary)]">
          {formatDuration(run.durationMs)} ·{" "}
          {formatScheduleCost(run.estimatedCostUsd)}
        </div>
        {run.status === "error" && run.error ? (
          <div className="mt-0.5 text-body-small-default text-[var(--system-negative-strong)]">
            {run.error.slice(0, 120)}
            {run.error.length > 120 ? "…" : ""}
          </div>
        ) : null}
      </div>
      {isInteractive ? (
        <ChevronRight
          className={cn(
            "h-4 w-4 shrink-0 text-[var(--content-tertiary)] transition-transform",
            hasExpand && isExpanded ? "rotate-90" : "",
          )}
        />
      ) : null}
    </>
  );

  const details =
    hasExpand && isExpanded ? (
      <div id={detailsId} className="px-2 pb-3">
        <div className="space-y-3 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-3">
          {conversations.length > 0 ? (
            <div>
              <div className="mb-1 text-body-small-default text-[var(--content-secondary)]">
                Conversations
              </div>
              <div className="space-y-1">
                {conversations.map((c) =>
                  canOpenRunConversation(c) ? (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => onOpenConversation(c.id)}
                      className="block w-full truncate text-left text-body-small-default text-[var(--content-default)] hover:underline"
                    >
                      {hasRunText(c.title) ? c.title : "Conversation"}
                    </button>
                  ) : (
                    <span
                      key={c.id}
                      className="block truncate text-body-small-default text-[var(--content-tertiary)] italic"
                    >
                      {hasRunText(c.title) ? c.title : "Conversation"}{" "}
                      {c.exists ? "(archived)" : "(unavailable)"}
                    </span>
                  ),
                )}
              </div>
            </div>
          ) : null}
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
    ) : null;

  if (directOpenId) {
    return (
      <div>
        <button
          type="button"
          onClick={() => onOpenConversation(directOpenId)}
          aria-label={`Open conversation for run at ${formatTimestamp(run.startedAt)}`}
          className="flex w-full cursor-pointer items-center gap-3 px-2 py-3 text-left shadow-none transition-colors hover:bg-[var(--surface-hover)] focus:outline-none"
        >
          {body}
        </button>
      </div>
    );
  }

  if (hasExpand) {
    return (
      <div>
        <button
          type="button"
          onClick={() => onToggleDetails(run.id)}
          aria-label={`Toggle details for run at ${formatTimestamp(run.startedAt)}`}
          aria-expanded={isExpanded}
          aria-controls={detailsId}
          className="flex w-full cursor-pointer items-center gap-3 px-2 py-3 text-left shadow-none transition-colors hover:bg-[var(--surface-hover)] focus:outline-none"
        >
          {body}
        </button>
        {details}
      </div>
    );
  }

  return <div className="flex items-center gap-3 px-2 py-3">{body}</div>;
}

function RecentRuns({
  runs,
  isLoading,
  disableDirectOpen,
  onOpenConversation,
}: {
  runs: ScheduleRun[] | undefined;
  isLoading: boolean;
  disableDirectOpen: boolean;
  onOpenConversation: (conversationId: string) => void;
}) {
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="h-5 w-5 animate-spin text-stone-400" />
      </div>
    );
  }
  if (!runs || runs.length === 0) {
    return (
      <p className="py-2 text-body-medium-lighter text-[var(--content-tertiary)] italic">
        No runs yet.
      </p>
    );
  }
  return (
    <div className="divide-y divide-[var(--border-base)]">
      {runs.map((run, index) => (
        <RunRow
          key={run.id}
          run={run}
          index={index}
          isExpanded={expandedRunId === run.id}
          disableDirectOpen={disableDirectOpen}
          onOpenConversation={onOpenConversation}
          onToggleDetails={(runId) =>
            setExpandedRunId((current) => (current === runId ? null : runId))
          }
        />
      ))}
    </div>
  );
}

export interface ScheduleDetailPanelProps {
  schedule: Schedule;
  assistantId: string;
  usage: ScheduleRowUsage;
  isMobile?: boolean;
  onClose: () => void;
  onDeleted: () => void;
}

/**
 * Inline schedule detail shown in the home right pane (mirrors `HomeDetailPanel`
 * so the schedule and feed-item details share one consistent side-panel UX).
 */
export function ScheduleDetailPanel({
  schedule,
  assistantId,
  usage,
  isMobile,
  onClose,
  onDeleted,
}: ScheduleDetailPanelProps) {
  const navigate = useNavigate();
  const { data: runs, isLoading } = useQuery({
    queryKey: schedulesByIdRunsGetQueryKey({
      path: { assistant_id: assistantId, id: schedule.id },
    }),
    queryFn: () => fetchScheduleRuns(assistantId, schedule.id),
    staleTime: 10_000,
  });

  const [isRunning, setIsRunning] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleRunNow = async () => {
    setIsRunning(true);
    try {
      await runScheduleNow(assistantId, schedule.id);
    } catch (error) {
      captureError(error, { context: "schedule_run_now" });
      toast.error("Failed to run schedule.");
    } finally {
      setIsRunning(false);
    }
  };

  const handleDelete = async () => {
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
  };

  return (
    <div
      className={cn(
        "flex h-full flex-col bg-[var(--surface-overlay)]",
        !isMobile &&
          "rounded-[var(--radius-xl)] border border-[var(--border-base)]",
      )}
    >
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-[var(--border-base)] p-[var(--app-spacing-lg)]">
        <div className="min-w-0 flex-1">
          <Typography
            variant="title-small"
            className="truncate text-[var(--content-default)]"
          >
            {schedule.name}
          </Typography>
        </div>
        <Button
          variant="ghost"
          iconOnly={<X />}
          onClick={onClose}
          aria-label="Close schedule details"
          tooltip="Close"
          className="shrink-0"
        />
      </div>

      {/* Scrollable body */}
      <div className="flex-1 space-y-6 overflow-y-auto px-[var(--app-spacing-lg)] py-[var(--app-spacing-lg)]">
        {schedule.description ? (
          <p className="text-body-medium-lighter text-[var(--content-secondary)]">
            {schedule.description}
          </p>
        ) : null}

        <section>
          <SectionLabel>Details</SectionLabel>
          <div className="rounded-lg border border-[var(--border-base)] bg-[var(--surface-lift)] px-4 py-2">
            {schedule.cadenceDescription ? (
              <InfoRow label="Cadence" value={schedule.cadenceDescription} />
            ) : null}
            <InfoRow label="Mode" value={schedule.mode} />
            <InfoRow
              label="Status"
              value={schedule.enabled ? "Enabled" : "Disabled"}
            />
            <InfoRow
              label="Next run"
              value={formatTimestamp(schedule.nextRunAt)}
            />
            {schedule.lastRunAt ? (
              <InfoRow
                label="Last run"
                value={
                  <span className="flex items-center justify-end gap-2">
                    <StatusDot status={schedule.lastStatus} />
                    {formatTimestamp(schedule.lastRunAt)}
                  </span>
                }
              />
            ) : null}
          </div>
        </section>

        <StatCards usage={usage} />

        <section>
          <SectionLabel>Recent runs</SectionLabel>
          <RecentRuns
            runs={runs?.runs}
            isLoading={isLoading}
            disableDirectOpen={schedule.mode === "script"}
            onOpenConversation={(conversationId) =>
              navigate(routes.conversation(conversationId))
            }
          />
        </section>
      </div>

      {/* Footer actions */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-[var(--border-base)] p-[var(--app-spacing-lg)]">
        {!confirmingDelete ? (
          <Button
            variant="dangerOutline"
            leftIcon={<Trash2 className="h-3.5 w-3.5" />}
            onClick={() => setConfirmingDelete(true)}
          >
            Delete
          </Button>
        ) : (
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              onClick={() => setConfirmingDelete(false)}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => void handleDelete()}
              disabled={isDeleting}
            >
              {isDeleting ? "Deleting…" : "Yes, delete"}
            </Button>
          </div>
        )}
        <div className="flex items-center gap-2">
          <Button
            variant="outlined"
            leftIcon={<BarChart3 className="h-3.5 w-3.5" />}
            onClick={() => navigate(routes.logs.usageForSchedule(schedule.id))}
          >
            View usage
          </Button>
          {schedule.mode === "script" ? (
            <Button
              variant="primary"
              leftIcon={
                isRunning ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : undefined
              }
              onClick={() => void handleRunNow()}
              disabled={isRunning}
            >
              {isRunning ? "Running…" : "Run now"}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
