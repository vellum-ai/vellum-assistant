import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Calendar, Loader2, Plus } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";

import { DetailCard } from "@/components/detail-card";
import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { fetchSchedules, toggleSchedule } from "@/domains/settings/api/schedules";
import { CreateScheduleModal } from "@/domains/settings/components/create-schedule-modal";
import { ScheduleDetailView } from "@/domains/settings/components/schedule-detail-view";
import { ScheduleRow } from "@/domains/settings/components/schedule-row";
import { SystemTaskDetailView } from "@/domains/settings/components/system-task-detail-view";
import { SystemTasksSection } from "@/domains/settings/components/system-tasks-section";
import { useSystemTasks } from "@/domains/settings/hooks/use-system-tasks";
import {
  consolidationSubtitle,
  heartbeatSubtitle,
  scheduleUsageSummaryQueryOptions,
  shouldShowSystemTaskToggles,
  sortSchedules,
  SYSTEM_TASK_URL_IDS,
  systemTaskKindFromUrlId,
  type ScheduleRowUsage,
  zeroScheduleUsageSummary,
} from "@/domains/settings/utils/schedule-formatters";
import { captureError } from "@/lib/sentry/capture-error";
import { assistantSchedulesQueryKey } from "@/lib/sync/query-tags";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { routes } from "@/utils/routes";
import { useEffectiveTimezone } from "@/utils/use-effective-timezone";
import { Button } from "@vellumai/design-library/components/button";
import { Notice } from "@vellumai/design-library/components/notice";
import { toast } from "@vellumai/design-library/components/toast";

// ---------------------------------------------------------------------------
// Small inline sub-components (single-consumer, not worth own files)
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
    <div className="space-y-4">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1.5 text-body-medium-lighter text-[var(--content-secondary)] hover:text-[var(--content-default)] transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to schedules
      </button>
      <Notice tone="error">
        Schedule not found. It may have been deleted or the link may be out of
        date.
      </Notice>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function SchedulesPage() {
  const navigate = useNavigate();
  const { scheduleId } = useParams<{ scheduleId?: string }>();
  const tz = useEffectiveTimezone();
  const assistantFlagsHydrated =
    useAssistantFeatureFlagStore.use.hasHydrated();
  const systemScheduleToggles =
    useAssistantFeatureFlagStore.use.systemScheduleToggles();
  const showSystemTaskToggles = shouldShowSystemTaskToggles(
    assistantFlagsHydrated,
    systemScheduleToggles,
  );
  const assistantId = useActiveAssistantId();

  // -------------------------------------------------------------------------
  // User schedule queries
  // -------------------------------------------------------------------------

  const {
    data: schedules,
    isLoading: isSchedulesLoading,
    isError: isSchedulesError,
    refetch,
  } = useQuery({
    queryKey: assistantSchedulesQueryKey(assistantId),
    queryFn: () => fetchSchedules(assistantId),
    staleTime: 10_000,
  });

  const {
    data: usageSummaries,
    isLoading: isUsageSummaryLoading,
    isError: isUsageSummaryError,
  } = useQuery(
    scheduleUsageSummaryQueryOptions(assistantId, tz, scheduleId == null),
  );

  // -------------------------------------------------------------------------
  // System tasks (heartbeat + consolidation)
  // -------------------------------------------------------------------------

  const systemTasks = useSystemTasks(assistantId, tz);

  // -------------------------------------------------------------------------
  // Derived state
  // -------------------------------------------------------------------------

  const selectedSystemTask = systemTaskKindFromUrlId(scheduleId);
  const [createOpen, setCreateOpen] = useState(false);

  const selectedSchedule = useMemo(
    () =>
      scheduleId && !selectedSystemTask
        ? (schedules?.find((schedule) => schedule.id === scheduleId) ?? null)
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
    (id: string): ScheduleRowUsage => {
      if (isUsageSummaryLoading) return { status: "loading" };
      if (isUsageSummaryError) return { status: "error" };
      return {
        status: "ready",
        summary:
          usageSummaryByScheduleId.get(id) ?? zeroScheduleUsageSummary(id),
      };
    },
    [isUsageSummaryError, isUsageSummaryLoading, usageSummaryByScheduleId],
  );

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  const navigateToSchedules = () => navigate(routes.settings.schedules);

  const navigateToSchedule = (id: string) =>
    navigate(routes.settings.schedule(id));

  const handleCreated = useCallback(() => {
    setCreateOpen(false);
    void refetch();
    toast.success("Schedule created.");
  }, [refetch]);

  const handleToggle = useCallback(
    async (id: string, enabled: boolean) => {
      try {
        await toggleSchedule(assistantId, id, enabled);
        void refetch();
      } catch (error) {
        captureError(error, { context: "schedule_toggle" });
        toast.error("Failed to toggle schedule.");
      }
    },
    [assistantId, refetch],
  );

  // -------------------------------------------------------------------------
  // View routing
  // -------------------------------------------------------------------------

  if (
    selectedSystemTask === "heartbeat" &&
    systemTasks.heartbeatConfig
  ) {
    return (
      <SystemTaskDetailView
        key="heartbeat"
        kind="heartbeat"
        assistantId={assistantId}
        name="Heartbeat"
        subtitle={heartbeatSubtitle(systemTasks.heartbeatConfig)}
        enabled={systemTasks.heartbeatConfig.enabled}
        nextRunAt={systemTasks.heartbeatConfig.nextRunAt}
        lastRunAt={systemTasks.heartbeatConfig.lastRunAt}
        isRunning={systemTasks.isHeartbeatRunning}
        onBack={navigateToSchedules}
        onRunNow={() => void systemTasks.handleRunNow("heartbeat")}
      />
    );
  }

  if (
    selectedSystemTask === "consolidation" &&
    systemTasks.consolidationConfig?.available === true
  ) {
    return (
      <SystemTaskDetailView
        key="consolidation"
        kind="consolidation"
        assistantId={assistantId}
        name="Consolidation"
        subtitle={consolidationSubtitle(systemTasks.consolidationConfig)}
        enabled={systemTasks.consolidationConfig.enabled}
        nextRunAt={systemTasks.consolidationConfig.nextRunAt}
        lastRunAt={systemTasks.consolidationConfig.lastRunAt}
        isRunning={systemTasks.isConsolidationRunning}
        onBack={navigateToSchedules}
        onRunNow={() => void systemTasks.handleRunNow("consolidation")}
      />
    );
  }

  if (selectedSchedule) {
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

  if (isSchedulesLoading || (selectedSystemTask && systemTasks.isLoading)) {
    return (
      <div className="w-full">
        <div className="flex min-h-[400px] items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-stone-400" />
        </div>
      </div>
    );
  }

  if (isSchedulesError && !schedules) {
    return (
      <div className="w-full">
        <Notice tone="error">
          Failed to load schedules.{" "}
          <button
            type="button"
            onClick={() => void refetch()}
            className="cursor-pointer underline hover:no-underline"
          >
            Retry
          </button>
        </Notice>
      </div>
    );
  }

  if (selectedSystemTask && systemTasks.hasError) {
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
                void systemTasks.refetchHeartbeat();
              } else {
                void systemTasks.refetchConsolidation();
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
      !systemTasks.hasAnySystemTask &&
      !systemTasks.isLoading &&
      !systemTasks.hasError)
  ) {
    return (
      <div className="w-full">
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
    <div className="space-y-4">
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
        heartbeatConfig={systemTasks.heartbeatConfig}
        consolidationConfig={systemTasks.consolidationConfig}
        heartbeatUsage={systemTasks.heartbeatUsage}
        consolidationUsage={systemTasks.consolidationUsage}
        isLoading={systemTasks.isLoading}
        hasError={systemTasks.hasError}
        onRetry={systemTasks.refetchAll}
        onSelectHeartbeat={() =>
          navigateToSchedule(SYSTEM_TASK_URL_IDS.heartbeat)
        }
        onSelectConsolidation={() =>
          navigateToSchedule(SYSTEM_TASK_URL_IDS.consolidation)
        }
        showSystemTaskToggles={showSystemTaskToggles}
        onToggleHeartbeat={(enabled) =>
          void systemTasks.handleToggle("heartbeat", enabled)
        }
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
