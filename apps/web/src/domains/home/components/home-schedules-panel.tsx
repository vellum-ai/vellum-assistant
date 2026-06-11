import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";

import { useHomeSchedulesData } from "@/domains/home/hooks/use-home-schedules-data";
import { ScheduleSummaryCard } from "@/domains/home/components/schedule-summary-card";
import { ScheduleDetailView } from "@/domains/settings/components/schedule-detail-view";
import { ScheduleRow } from "@/domains/settings/components/schedule-row";
import { SystemTaskDetailView } from "@/domains/settings/components/system-task-detail-view";
import { SystemTaskRow } from "@/domains/settings/components/system-tasks-section";
import {
  consolidationSubtitle,
  heartbeatSubtitle,
} from "@/domains/settings/utils/schedule-formatters";
import { routes } from "@/utils/routes";
import { Notice } from "@vellumai/design-library/components/notice";

import type { SystemTaskKind } from "@/domains/settings/types/schedules";

type ExpandedCard = "schedules" | "system" | null;

type Selection =
  | { type: "schedule"; id: string }
  | { type: "system"; kind: SystemTaskKind }
  | null;

export function HomeSchedulesPanel({ assistantId }: { assistantId: string }) {
  const navigate = useNavigate();
  const {
    recurring,
    oneTime,
    usageForSchedule,
    schedulesTotalCostLabel,
    schedulesCostStatus,
    systemTotalCostLabel,
    systemCostStatus,
    systemTasks,
    showSystemTaskToggles,
    handleToggle,
    isLoading,
    isError,
    refetch,
  } = useHomeSchedulesData(assistantId);

  const [expandedCard, setExpandedCard] = useState<ExpandedCard>(null);
  const [selection, setSelection] = useState<Selection>(null);

  // -------------------------------------------------------------------------
  // Detail mode — resolve the selected target, guarding against stale ids.
  // -------------------------------------------------------------------------

  const selectedSchedule =
    selection?.type === "schedule"
      ? (recurring.find((s) => s.id === selection.id) ??
        oneTime.find((s) => s.id === selection.id) ??
        null)
      : null;

  const heartbeatConfig = systemTasks.heartbeatConfig;
  const consolidationConfig = systemTasks.consolidationConfig;
  const selectedSystemKind =
    selection?.type === "system" ? selection.kind : null;
  const systemDetailAvailable =
    selectedSystemKind === "heartbeat"
      ? heartbeatConfig != null
      : selectedSystemKind === "consolidation"
        ? consolidationConfig?.available === true
        : false;

  // If the selection points at something that no longer exists (e.g. after a
  // refetch/delete, or because the config became unavailable), return to cards.
  const staleSelection =
    (selection?.type === "schedule" && selectedSchedule == null) ||
    (selection?.type === "system" && !systemDetailAvailable);
  useEffect(() => {
    if (staleSelection) setSelection(null);
  }, [staleSelection]);

  if (selectedSchedule) {
    return (
      <ScheduleDetailView
        key={selectedSchedule.id}
        schedule={selectedSchedule}
        assistantId={assistantId}
        onBack={() => setSelection(null)}
        onDeleted={() => {
          setSelection(null);
          refetch();
        }}
        onUpdated={refetch}
      />
    );
  }

  if (selectedSystemKind === "heartbeat" && heartbeatConfig) {
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
        isRunning={systemTasks.isHeartbeatRunning}
        onBack={() => setSelection(null)}
        onRunNow={() => void systemTasks.handleRunNow("heartbeat")}
        onOpenMemorySettings={undefined}
      />
    );
  }

  if (
    selectedSystemKind === "consolidation" &&
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
        isRunning={systemTasks.isConsolidationRunning}
        onBack={() => setSelection(null)}
        onRunNow={() => void systemTasks.handleRunNow("consolidation")}
        onOpenMemorySettings={undefined}
      />
    );
  }

  // -------------------------------------------------------------------------
  // Loading skeleton
  // -------------------------------------------------------------------------

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 gap-[var(--app-spacing-md)] md:grid-cols-2">
        <ScheduleSummaryCard
          title="Schedules"
          subtitle="Recurring automations managed by your assistant."
          costLabel=""
          costStatus="loading"
          isExpanded={false}
          onToggleExpand={() => {}}
        />
        <ScheduleSummaryCard
          title="System"
          subtitle="Built-in jobs managed by the assistant runtime."
          costLabel=""
          costStatus="loading"
          isExpanded={false}
          onToggleExpand={() => {}}
        />
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Error state
  // -------------------------------------------------------------------------

  if (isError && recurring.length === 0) {
    return (
      <Notice
        tone="error"
        actions={
          <button
            type="button"
            onClick={refetch}
            className="cursor-pointer underline hover:no-underline"
          >
            Retry
          </button>
        }
      >
        Failed to load schedules.
      </Notice>
    );
  }

  // -------------------------------------------------------------------------
  // Empty: nothing to show
  // -------------------------------------------------------------------------

  if (
    recurring.length === 0 &&
    oneTime.length === 0 &&
    !systemTasks.hasAnySystemTask
  ) {
    return null;
  }

  // -------------------------------------------------------------------------
  // Cards mode
  // -------------------------------------------------------------------------

  const toggleCard = (card: Exclude<ExpandedCard, null>) =>
    setExpandedCard((c) => (c === card ? null : card));

  const renderScheduleRow = (schedule: (typeof recurring)[number]) => (
    <ScheduleRow
      key={schedule.id}
      schedule={schedule}
      usage={usageForSchedule(schedule.id)}
      onClick={() => setSelection({ type: "schedule", id: schedule.id })}
      onToggle={(enabled) => void handleToggle(schedule.id, enabled)}
      onOpenUsage={() => navigate(routes.logs.usageForSchedule(schedule.id))}
    />
  );

  return (
    <div className="grid grid-cols-1 gap-[var(--app-spacing-md)] md:grid-cols-2">
      <div className={expandedCard === "schedules" ? "md:col-span-2" : undefined}>
        <ScheduleSummaryCard
          title="Schedules"
          subtitle="Recurring automations managed by your assistant."
          costLabel={schedulesTotalCostLabel}
          costStatus={schedulesCostStatus}
          isExpanded={expandedCard === "schedules"}
          onToggleExpand={() => toggleCard("schedules")}
        >
          {recurring.length === 0 && oneTime.length === 0 ? (
            <p className="text-body-small-default text-[var(--content-tertiary)]">
              No schedules yet
            </p>
          ) : (
            <div>
              {recurring.map(renderScheduleRow)}
              {oneTime.length > 0 ? (
                <>
                  <p className="mt-3 px-2 text-label-small-default text-[var(--content-tertiary)]">
                    One-time
                  </p>
                  {oneTime.map(renderScheduleRow)}
                </>
              ) : null}
            </div>
          )}
        </ScheduleSummaryCard>
      </div>

      <div className={expandedCard === "system" ? "md:col-span-2" : undefined}>
        <ScheduleSummaryCard
          title="System"
          subtitle="Built-in jobs managed by the assistant runtime."
          costLabel={systemTotalCostLabel}
          costStatus={systemCostStatus}
          isExpanded={expandedCard === "system"}
          onToggleExpand={() => toggleCard("system")}
        >
          <SystemCardBody
            systemTasks={systemTasks}
            showSystemTaskToggles={showSystemTaskToggles}
            onSelectHeartbeat={() =>
              setSelection({ type: "system", kind: "heartbeat" })
            }
            onSelectConsolidation={() =>
              setSelection({ type: "system", kind: "consolidation" })
            }
          />
        </ScheduleSummaryCard>
      </div>
    </div>
  );
}

function SystemCardBody({
  systemTasks,
  showSystemTaskToggles,
  onSelectHeartbeat,
  onSelectConsolidation,
}: {
  systemTasks: ReturnType<typeof useHomeSchedulesData>["systemTasks"];
  showSystemTaskToggles: boolean;
  onSelectHeartbeat: () => void;
  onSelectConsolidation: () => void;
}) {
  const {
    heartbeatConfig,
    consolidationConfig,
    heartbeatUsage,
    consolidationUsage,
    isLoading,
    hasError,
  } = systemTasks;
  const showHeartbeat = heartbeatConfig != null;
  const showConsolidation = consolidationConfig?.available === true;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-stone-400" />
      </div>
    );
  }

  if (hasError && !showHeartbeat && !showConsolidation) {
    return (
      <Notice tone="error">
        Failed to load system jobs.{" "}
        <button
          type="button"
          onClick={systemTasks.refetchAll}
          className="cursor-pointer underline hover:no-underline"
        >
          Retry
        </button>
      </Notice>
    );
  }

  if (!showHeartbeat && !showConsolidation) {
    return (
      <p className="text-body-small-default text-[var(--content-tertiary)]">
        No system jobs yet
      </p>
    );
  }

  return (
    <div>
      {showHeartbeat ? (
        <SystemTaskRow
          name="Heartbeat"
          subtitle={heartbeatSubtitle(heartbeatConfig)}
          enabled={heartbeatConfig.enabled}
          nextRunAt={heartbeatConfig.nextRunAt}
          lastRunAt={heartbeatConfig.lastRunAt}
          usage={heartbeatUsage}
          showToggle={showSystemTaskToggles}
          onClick={onSelectHeartbeat}
          onToggle={(enabled) =>
            void systemTasks.handleToggle("heartbeat", enabled)
          }
        />
      ) : null}
      {showConsolidation ? (
        <SystemTaskRow
          name="Consolidation"
          subtitle={consolidationSubtitle(consolidationConfig)}
          enabled={consolidationConfig.enabled}
          helperText={
            consolidationConfig.enabled
              ? undefined
              : "Memory is off, so consolidation is paused."
          }
          nextRunAt={consolidationConfig.nextRunAt}
          lastRunAt={consolidationConfig.lastRunAt}
          usage={consolidationUsage}
          showToggle={false}
          statusLabel={consolidationConfig.enabled ? undefined : "Paused"}
          statusTone="warning"
          onClick={onSelectConsolidation}
        />
      ) : null}
      {hasError ? (
        <div className="pt-3 first:pt-0">
          <Notice tone="error">
            Some system jobs failed to load.{" "}
            <button
              type="button"
              onClick={systemTasks.refetchAll}
              className="cursor-pointer underline hover:no-underline"
            >
              Retry
            </button>
          </Notice>
        </div>
      ) : null}
    </div>
  );
}
