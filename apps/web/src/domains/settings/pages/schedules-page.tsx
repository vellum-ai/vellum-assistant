import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Calendar, ChevronDown, Loader2, Plus } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useNavigate, useParams } from "react-router";

import { DetailCard } from "@/components/detail-card";
import { getAssistantHealthz } from "@/assistant/api";
import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { fetchSchedules, toggleSchedule } from "@/domains/settings/api/schedules";
import { CreateScheduleModal } from "@/domains/settings/components/create-schedule-modal";
import { ScheduleDetailView } from "@/domains/settings/components/schedule-detail-view";
import { ScheduleRow } from "@/domains/settings/components/schedule-row";
import { ScheduleListColumnsHeader } from "@/domains/settings/components/schedule-shared-ui";
import { SystemTaskDetailView } from "@/domains/settings/components/system-task-detail-view";
import { SystemTasksSection } from "@/domains/settings/components/system-tasks-section";
import { useSystemTasks } from "@/domains/settings/hooks/use-system-tasks";
import {
  consolidationSubtitle,
  groupSchedules,
  heartbeatSubtitle,
  pastOneTimeStatus,
  RETROSPECTIVE_SUBTITLE,
  scheduleUsageSummaryQueryOptions,
  SYSTEM_TASK_URL_IDS,
  systemTaskKindFromUrlId,
  type ScheduleRowUsage,
  zeroScheduleUsageSummary,
} from "@/domains/settings/utils/schedule-formatters";
import { captureError } from "@/lib/sentry/capture-error";
import type { Schedule } from "@/domains/settings/types/schedules";
import { assistantSchedulesQueryKey } from "@/lib/sync/query-tags";
import { routes } from "@/utils/routes";
import { useEffectiveTimezone } from "@/utils/use-effective-timezone";
import { Button } from "@vellumai/design-library/components/button";
import { Collapsible } from "@vellumai/design-library/components/collapsible";
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

function ScheduleGroup({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="[&+&]:mt-4">
      <div className="px-2 pb-1 text-label-medium-default uppercase tracking-wider text-[var(--content-tertiary)]">
        {label}
      </div>
      <div>{children}</div>
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
  // System tasks (heartbeat + consolidation + memory retrospective)
  // -------------------------------------------------------------------------

  const systemTasks = useSystemTasks(assistantId, tz);
  const { data: canOpenMemorySettings = false } = useQuery({
    queryKey: ["assistant-memory-opt-out-capability", assistantId],
    queryFn: async () => {
      const result = await getAssistantHealthz(assistantId);
      return result.ok && result.data.capabilities?.memoryOptOut === true;
    },
    retry: false,
    staleTime: 10_000,
  });

  // -------------------------------------------------------------------------
  // Derived state
  // -------------------------------------------------------------------------

  const selectedSystemTask = systemTaskKindFromUrlId(scheduleId);
  const [createOpen, setCreateOpen] = useState(false);
  // Mount-time snapshot (impure calls are not allowed during render); the
  // upcoming/past one-shot boundary doesn't need to move while the page is up.
  const [now] = useState(() => Date.now());

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

  const navigateToMemorySettings = () => navigate(routes.settings.advanced);

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
        onToggleEnabled={(enabled) =>
          void systemTasks.handleToggle("heartbeat", enabled)
        }
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
        onOpenMemorySettings={
          canOpenMemorySettings ? navigateToMemorySettings : undefined
        }
      />
    );
  }

  if (
    selectedSystemTask === "retrospective" &&
    systemTasks.retrospectiveConfig?.available === true
  ) {
    // Event-driven task: no onRunNow (nothing global to trigger) and
    // nextRunAt is always null by design.
    return (
      <SystemTaskDetailView
        key="retrospective"
        kind="retrospective"
        assistantId={assistantId}
        name="Memory retrospective"
        subtitle={RETROSPECTIVE_SUBTITLE}
        enabled={systemTasks.retrospectiveConfig.enabled}
        nextRunAt={systemTasks.retrospectiveConfig.nextRunAt}
        lastRunAt={systemTasks.retrospectiveConfig.lastRunAt}
        isRunning={false}
        onBack={navigateToSchedules}
        onOpenMemorySettings={
          canOpenMemorySettings ? navigateToMemorySettings : undefined
        }
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
          {selectedSystemTask === "heartbeat"
            ? "heartbeat"
            : selectedSystemTask === "consolidation"
              ? "consolidation"
              : "memory retrospective"}{" "}
          schedule.{" "}
          <button
            type="button"
            onClick={() => {
              if (selectedSystemTask === "heartbeat") {
                void systemTasks.refetchHeartbeat();
              } else if (selectedSystemTask === "consolidation") {
                void systemTasks.refetchConsolidation();
              } else {
                void systemTasks.refetchRetrospective();
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

  const scheduleList = schedules ?? [];
  const { recurring, upcomingOneTime, pastOneTime } = groupSchedules(
    scheduleList,
    now,
  );
  const hasActiveSchedules =
    recurring.length > 0 || upcomingOneTime.length > 0;

  const renderRow = (schedule: Schedule, past = false) => (
    <ScheduleRow
      key={schedule.id}
      schedule={schedule}
      usage={usageForSchedule(schedule.id)}
      onClick={() => navigateToSchedule(schedule.id)}
      onToggle={(enabled) => void handleToggle(schedule.id, enabled)}
      onOpenUsage={() => navigate(routes.logs.usageForSchedule(schedule.id))}
      pastStatus={past ? pastOneTimeStatus(schedule) : undefined}
    />
  );

  return (
    <div className="space-y-4">
      {scheduleList.length > 0 ? (
        <div className="flex items-center justify-end">
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            New schedule
          </Button>
        </div>
      ) : null}

      {isUsageSummaryError ? (
        <Notice tone="warning" className="py-2 text-body-small-default">
          Schedule usage stats are unavailable right now.
        </Notice>
      ) : null}

      {scheduleList.length === 0 ? (
        <EmptyState onCreate={() => setCreateOpen(true)} />
      ) : (
        <DetailCard title="Schedules">
          <div>
            <ScheduleListColumnsHeader />
            {recurring.length > 0 && (
              <ScheduleGroup label="Recurring">
                {recurring.map((schedule) => renderRow(schedule))}
              </ScheduleGroup>
            )}
            {upcomingOneTime.length > 0 && (
              <ScheduleGroup label="One-time">
                {upcomingOneTime.map((schedule) => renderRow(schedule))}
              </ScheduleGroup>
            )}
            {!hasActiveSchedules && (
              <p className="px-2 py-3 text-body-small-default text-[var(--content-tertiary)]">
                No upcoming schedules.
              </p>
            )}
            {pastOneTime.length > 0 && (
              <Collapsible.Root
                type="multiple"
                className="mt-3 border-t border-[var(--border-base)] pt-1"
              >
                <Collapsible.Item value="past-one-time">
                  <Collapsible.Trigger className="group gap-2 rounded-md px-2 py-2 text-body-small-default text-[var(--content-tertiary)] transition-colors hover:bg-[var(--surface-hover)]">
                    <ChevronDown className="h-4 w-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
                    Past one-time ({pastOneTime.length})
                  </Collapsible.Trigger>
                  <Collapsible.Content>
                    <div>
                      {pastOneTime.map((schedule) => renderRow(schedule, true))}
                    </div>
                  </Collapsible.Content>
                </Collapsible.Item>
              </Collapsible.Root>
            )}
          </div>
        </DetailCard>
      )}

      <SystemTasksSection
        heartbeatConfig={systemTasks.heartbeatConfig}
        consolidationConfig={systemTasks.consolidationConfig}
        retrospectiveConfig={systemTasks.retrospectiveConfig}
        heartbeatUsage={systemTasks.heartbeatUsage}
        consolidationUsage={systemTasks.consolidationUsage}
        retrospectiveUsage={systemTasks.retrospectiveUsage}
        isLoading={systemTasks.isLoading}
        hasError={systemTasks.hasError}
        onRetry={systemTasks.refetchAll}
        onSelectHeartbeat={() =>
          navigateToSchedule(SYSTEM_TASK_URL_IDS.heartbeat)
        }
        onSelectConsolidation={() =>
          navigateToSchedule(SYSTEM_TASK_URL_IDS.consolidation)
        }
        onSelectRetrospective={() =>
          navigateToSchedule(SYSTEM_TASK_URL_IDS.retrospective)
        }
      />

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
