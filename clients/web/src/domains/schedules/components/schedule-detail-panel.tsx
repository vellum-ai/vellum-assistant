import type { ReactNode } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BarChart3,
  ChevronRight,
  Coins,
  Loader2,
  Repeat,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";

import { DetailShellHeader } from "@/components/detail-shell";
import { InsetDetailCard } from "@/components/inset-detail-card";
import { useTranslation } from "@/i18n";
import { SCHEDULE_USAGE_WINDOW_DAYS } from "@/utils/usage-window";
import {
  disarmReasonLabelKey,
  pluginNameFromSourceKey,
} from "@/domains/schedules/plugin-source";
import {
  cancelSchedule,
  deleteSchedule,
  fetchScheduleRuns,
  runScheduleNow,
  updateSchedule,
} from "@/domains/settings/api/schedules";
import { ModelProfileRow } from "@/domains/settings/components/model-profile-row";
import { ModelProfileSelect } from "@/domains/settings/components/model-profile-select";
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
import {
  schedulesByIdRunsGetQueryKey,
  schedulesGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { navigateToConversation } from "@/utils/conversation-navigation";
import { routes } from "@/utils/routes";
import { Button, Skeleton, cn } from "@vellumai/design-library";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { toast } from "@vellumai/design-library/components/toast";

import type { Schedule, ScheduleRun } from "@/domains/settings/types/schedules";

/**
 * One label/value line in the Details card. `min-h-6` pins the row to 24px
 * whatever the value slot holds, matching `SystemTaskDetailPanel` so the two
 * schedules panels share one row rhythm; the enclosing stack owns the gap
 * between rows.
 */
function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex min-h-6 items-center justify-between gap-4">
      <span className="shrink-0 text-body-medium-lighter text-[var(--content-secondary)]">
        {label}
      </span>
      <span className="min-w-0 text-right text-body-medium-lighter text-[var(--content-default)]">
        {value}
      </span>
    </div>
  );
}

/**
 * The schedule's pinned inference profile, and the control that changes it.
 *
 * Two modes get something other than a picker:
 *
 * - **Workflow schedules.** They carry a pin like every other schedule, but
 *   nothing reads it: a workflow's LLM calls resolve under their own per-leaf
 *   call sites. A picker here would claim a setting governs the run when it
 *   does not, so the row states the situation instead.
 * - **One-shots that have already fired.** Their model is history; there is no
 *   future run for a change to reach, so the pin is shown read-only.
 */
function ScheduleModelProfileField({
  schedule,
  assistantId,
  isPast,
}: {
  schedule: Schedule;
  assistantId: string;
  isPast: boolean;
}) {
  const { t } = useTranslation("schedules");
  const queryClient = useQueryClient();
  const schedulesQueryKey = schedulesGetQueryKey({
    path: { assistant_id: assistantId },
  });

  const profileMutation = useMutation({
    mutationFn: (inferenceProfile: string) =>
      updateSchedule(assistantId, schedule.id, { inferenceProfile }),
    onMutate: async (inferenceProfile) => {
      await queryClient.cancelQueries({ queryKey: schedulesQueryKey });
      const previousProfile = queryClient
        .getQueryData<Schedule[]>(schedulesQueryKey)
        ?.find((row) => row.id === schedule.id)?.inferenceProfile;
      queryClient.setQueryData<Schedule[]>(schedulesQueryKey, (rows) =>
        rows?.map((row) =>
          row.id === schedule.id ? { ...row, inferenceProfile } : row,
        ),
      );
      return { previousProfile };
    },
    onError: (error, _inferenceProfile, context) => {
      // Restore the profile alone. A snapshot of the whole list would undo a
      // toggle or another schedule's edit that landed while this was in flight.
      const previousProfile = context?.previousProfile;
      if (previousProfile !== undefined) {
        queryClient.setQueryData<Schedule[]>(schedulesQueryKey, (rows) =>
          rows?.map((row) =>
            row.id === schedule.id
              ? { ...row, inferenceProfile: previousProfile }
              : row,
          ),
        );
      }
      captureError(error, { context: "schedule_update_inference_profile" });
      toast.error(t("scheduleDetail.modelChangeFailed"));
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: schedulesQueryKey }),
  });

  if (schedule.mode === "workflow") {
    return (
      <>
        <InfoRow
          label={t("scheduleDetail.modelProfile")}
          value={t("scheduleDetail.notUsedForWorkflow")}
        />
        <p className="text-body-small-default text-[var(--content-tertiary)]">
          {t("scheduleDetail.modelProfileWorkflowNote")}
        </p>
      </>
    );
  }

  if (isPast) {
    return (
      <div className="text-body-medium-lighter text-[var(--content-default)]">
        <ModelProfileRow
          assistantId={assistantId}
          pinnedProfile={schedule.inferenceProfile}
        />
      </div>
    );
  }

  return (
    <InfoRow
      label={t("scheduleDetail.modelProfile")}
      value={
        <ModelProfileSelect
          assistantId={assistantId}
          value={schedule.inferenceProfile}
          onChange={(profileKey) => {
            if (profileKey && profileKey !== schedule.inferenceProfile) {
              profileMutation.mutate(profileKey);
            }
          }}
          // A schedule always carries a concrete profile, and writing null
          // re-snapshots the current default rather than unpinning, so there
          // is no "follow my default" state to offer.
          includeDefaultOption={false}
          // A pin naming a deleted profile matches no option, so the trigger
          // asks for a choice instead of rendering blank.
          placeholder={t("scheduleDetail.chooseModel")}
          isSaving={profileMutation.isPending}
          // The row sits among read-only facts, so the trigger stays
          // borderless until aimed at. The negative margins cancel the
          // trigger's own padding, so its value lines up with the values
          // above and below it and its row stays their height.
          variant="ghost"
          // The trigger shrink-wraps at the right edge of the row, and its
          // menu is wider than it is, so the menu hangs from that same edge
          // rather than growing rightwards into the panel wall.
          menuAlign="end"
          className="-my-1 -mr-2"
        />
      }
    />
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
  const { t } = useTranslation("schedules");
  if (usage.status === "loading") {
    return (
      <div className="grid grid-cols-2 gap-3 pt-2">
        {Array.from({ length: 2 }, (_, i) => (
          <Skeleton key={i} className="h-[60px] rounded-lg" />
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
        label={t("scheduleDetail.costLabel", {
          days: SCHEDULE_USAGE_WINDOW_DAYS,
        })}
      />
      <StatCard
        icon={<Repeat className="h-4 w-4" />}
        value={formatScheduleRunCount(usage.summary.runCount)}
        label={t("scheduleDetail.runsLabel", {
          days: SCHEDULE_USAGE_WINDOW_DAYS,
        })}
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
  const { t } = useTranslation("schedules");
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
                {t("scheduleDetail.conversations")}
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
                      {hasRunText(c.title)
                        ? c.title
                        : t("scheduleDetail.conversation")}
                    </button>
                  ) : (
                    <span
                      key={c.id}
                      className="block truncate text-body-small-default text-[var(--content-tertiary)] italic"
                    >
                      {hasRunText(c.title)
                        ? c.title
                        : t("scheduleDetail.conversation")}{" "}
                      {c.exists
                        ? t("scheduleDetail.conversationArchived")
                        : t("scheduleDetail.conversationUnavailable")}
                    </span>
                  ),
                )}
              </div>
            </div>
          ) : null}
          {hasOutput ? (
            <div>
              <div className="mb-1 text-body-small-default text-[var(--content-secondary)]">
                {t("scheduleDetail.output")}
              </div>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-body-small-default font-mono text-[var(--content-default)]">
                {run.output}
              </pre>
            </div>
          ) : null}
          {hasError ? (
            <div>
              <div className="mb-1 text-body-small-default text-[var(--content-secondary)]">
                {t("scheduleDetail.error")}
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
          aria-label={t("scheduleDetail.openRunConversationAria", {
            time: formatTimestamp(run.startedAt),
          })}
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
          aria-label={t("scheduleDetail.toggleRunDetailsAria", {
            time: formatTimestamp(run.startedAt),
          })}
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
  const { t } = useTranslation("schedules");
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
        {t("scheduleDetail.noRunsYet")}
      </p>
    );
  }
  return (
    // `-mx-2` cancels the rows' own `px-2` against the enclosing
    // `InsetDetailCard` padding, so row text lines up with the card's edge
    // while each row's hover fill still bleeds the full width.
    <div className="-mx-2 divide-y divide-[var(--border-base)]">
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
  /** True for a one-shot that has already fired, which is read-only. */
  isPast?: boolean;
  onClose: () => void;
  onDeleted: () => void;
}

/**
 * Inline schedule detail shown in the Schedules page's right pane (mirrors the
 * Activity page's `HomeDetailPanel` so schedule and feed-item details share
 * one consistent side-panel UX).
 */
export function ScheduleDetailPanel({
  schedule,
  assistantId,
  usage,
  isPast = false,
  onClose,
  onDeleted,
}: ScheduleDetailPanelProps) {
  const { t } = useTranslation("schedules");
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
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const pluginName = pluginNameFromSourceKey(schedule.sourceKey);
  const disarmReasonKey = disarmReasonLabelKey(schedule);
  // Recurring rows pause from the list toggle. A pending one-shot has
  // nothing to pause, so cancel is the management action: it latches the
  // row cancelled and it leaves the upcoming list.
  const canCancelPending =
    schedule.isOneShot &&
    !isPast &&
    pluginName === null &&
    schedule.status !== "firing";
  // A plugin-sourced schedule is off either because the user turned it off or
  // because the plugin is disabled. Running it would execute the plugin's
  // script anyway, which the daemon refuses, so the affordance is disabled
  // here rather than surfacing that refusal as a failed run.
  const runNowBlocked = pluginName !== null && !schedule.enabled;

  const handleRunNow = async () => {
    setIsRunning(true);
    try {
      await runScheduleNow(assistantId, schedule.id);
    } catch (error) {
      captureError(error, { context: "schedule_run_now" });
      toast.error(t("scheduleDetail.runFailed"));
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
      toast.error(t("scheduleDetail.deleteFailed"));
      setIsDeleting(false);
      setConfirmingDelete(false);
    }
  };

  const handleCancel = async () => {
    setIsCancelling(true);
    try {
      await cancelSchedule(assistantId, schedule.id);
      onDeleted();
    } catch (error) {
      captureError(error, { context: "schedule_cancel" });
      toast.error(t("scheduleDetail.cancelOneTimeFailed"));
      setIsCancelling(false);
      setConfirmingCancel(false);
    }
  };

  return (
    <>
      {/* Card chrome is the docked pane's, not the full-screen takeover's, so
          it keys off the same `md:` breakpoint the page docks the pane at. */}
      <div className="flex h-full flex-col bg-[var(--surface-overlay)] md:rounded-[var(--radius-xl)] md:border md:border-[var(--border-base)]">
        <DetailShellHeader
          title={schedule.name}
          headerActions={
            pluginName ? undefined : (
              <Button
                variant="dangerOutline"
                iconOnly={<Trash2 />}
                aria-label={t("scheduleDetail.delete")}
                tooltip={t("scheduleDetail.delete")}
                onClick={() => setConfirmingDelete(true)}
              />
            )
          }
          closeLabel={t("scheduleDetail.closeAria")}
          closeTooltip={t("scheduleDetail.close")}
          onClose={onClose}
        />

        {/* Scrollable body */}
        <div className="flex-1 space-y-6 overflow-y-auto px-[var(--app-spacing-lg)] py-[var(--app-spacing-lg)]">
          {schedule.description ? (
            <p className="text-body-medium-lighter text-[var(--content-secondary)]">
              {schedule.description}
            </p>
          ) : null}

          <InsetDetailCard title={t("scheduleDetail.details")}>
            <div className="space-y-2">
              {schedule.cadenceDescription ? (
                <InfoRow
                  label={t("scheduleDetail.cadence")}
                  value={schedule.cadenceDescription}
                />
              ) : null}
              <InfoRow label={t("scheduleDetail.mode")} value={schedule.mode} />
              <ScheduleModelProfileField
                schedule={schedule}
                assistantId={assistantId}
                isPast={isPast}
              />
              <InfoRow
                label={t("scheduleDetail.status")}
                value={
                  schedule.enabled
                    ? t("scheduleDetail.enabled")
                    : t("scheduleDetail.disabled")
                }
              />
              <InfoRow
                label={t("scheduleDetail.nextRun")}
                value={formatTimestamp(schedule.nextRunAt)}
              />
              {schedule.lastRunAt ? (
                <InfoRow
                  label={t("scheduleDetail.lastRun")}
                  value={
                    <span className="flex items-center justify-end gap-2">
                      <StatusDot status={schedule.lastStatus} />
                      {formatTimestamp(schedule.lastRunAt)}
                    </span>
                  }
                />
              ) : null}
            </div>
          </InsetDetailCard>

          <StatCards usage={usage} />

          <InsetDetailCard title={t("scheduleDetail.recentRuns")}>
            <RecentRuns
              runs={runs?.runs}
              isLoading={isLoading}
              disableDirectOpen={schedule.mode === "script"}
              onOpenConversation={(conversationId) =>
                navigateToConversation(navigate, conversationId)
              }
            />
          </InsetDetailCard>
        </div>

        {/* Footer actions */}
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-[var(--border-hover)] p-[var(--app-spacing-lg)]">
          {pluginName ? (
            // Plugin-sourced schedules cannot be deleted here; the plugin's
            // schedule file is the source of truth, so only attribution shows.
            // Delete itself lives in the header, next to Close. An off
            // schedule says why alongside it, since the user is not
            // necessarily the one who turned it off.
            <span className="text-body-small-default text-[var(--content-tertiary)]">
              {disarmReasonKey
                ? t("scheduleDetail.managedByPluginPaused", {
                    plugin: pluginName,
                    reason: t(disarmReasonKey),
                  })
                : t("scheduleDetail.managedByPlugin", { plugin: pluginName })}
            </span>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <Button
              variant="outlined"
              leftIcon={<BarChart3 className="h-3.5 w-3.5" />}
              onClick={() =>
                navigate(routes.settings.usageForSchedule(schedule.id))
              }
            >
              {t("scheduleDetail.viewUsage")}
            </Button>
            {canCancelPending ? (
              <Button
                variant="dangerOutline"
                onClick={() => setConfirmingCancel(true)}
              >
                {t("scheduleDetail.cancelOneTime")}
              </Button>
            ) : null}
            {schedule.mode === "script" ? (
              <>
                {runNowBlocked ? (
                  // Plain text rather than a tooltip: a tooltip on a disabled
                  // button never opens, so the reason would be invisible exactly
                  // when it is needed.
                  <span className="text-body-small-default text-[var(--content-tertiary)]">
                    {t("scheduleDetail.turnOnToRun")}
                  </span>
                ) : null}
                <Button
                  variant="primary"
                  leftIcon={
                    isRunning ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : undefined
                  }
                  onClick={() => void handleRunNow()}
                  disabled={isRunning || runNowBlocked}
                >
                  {isRunning
                    ? t("scheduleDetail.running")
                    : t("scheduleDetail.runNow")}
                </Button>
              </>
            ) : null}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmingDelete}
        title={t("scheduleDetail.delete")}
        message={t("scheduleDetail.deleteConfirmMessage", {
          name: schedule.name,
        })}
        confirmLabel={t("scheduleDetail.confirmDelete")}
        cancelLabel={t("scheduleDetail.cancel")}
        destructive
        isPending={isDeleting}
        onConfirm={() => void handleDelete()}
        onCancel={() => setConfirmingDelete(false)}
      />

      <ConfirmDialog
        open={confirmingCancel}
        title={t("scheduleDetail.cancelOneTime")}
        message={t("scheduleDetail.cancelOneTimeConfirmMessage", {
          name: schedule.name,
        })}
        confirmLabel={t("scheduleDetail.confirmCancelOneTime")}
        cancelLabel={t("scheduleDetail.cancel")}
        destructive
        isPending={isCancelling}
        onConfirm={() => void handleCancel()}
        onCancel={() => setConfirmingCancel(false)}
      />
    </>
  );
}
