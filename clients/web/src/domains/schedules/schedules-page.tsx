import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";

import { getAssistantHealthz } from "@/assistant/api";
import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { CreateScheduleModal } from "@/domains/settings/components/create-schedule-modal";
import { SystemTasksSection } from "@/domains/settings/components/system-tasks-section";
import { useSystemTasks } from "@/domains/settings/hooks/use-system-tasks";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { navigateToNewConversation } from "@/utils/conversation-navigation";
import { routes } from "@/utils/routes";
import { useEffectiveTimezone } from "@/utils/use-effective-timezone";
import { ResizablePanel } from "@vellumai/design-library";

import type { SystemTaskKind } from "@/domains/settings/types/schedules";

import { ScheduleDetailPanel } from "./components/schedule-detail-panel";
import { SchedulesPanel } from "./components/schedules-panel";
import { SystemTaskDetailPanel } from "./components/system-task-detail-panel";
import { useSchedulesData } from "./hooks/use-schedules-data";

/**
 * Schedules — a drill-down section under the assistant overview. Mounted
 * inside `IntelligenceLayout`, which provides the shared page shell, heading,
 * and back chevron (the same chrome as Skills, Plugins, Workspace).
 *
 * The focused schedule is URL-owned (`/assistant/schedules/:scheduleId`) so
 * deep links, bookmarks, and back/forward work; system-task selection is
 * local state since system tasks have no per-item URLs.
 */
export function SchedulesPage() {
  const navigate = useNavigate();
  const { scheduleId } = useParams();
  const assistantId = useActiveAssistantId();
  const isMobile = useIsMobile();
  const tz = useEffectiveTimezone();

  const schedules = useSchedulesData(assistantId);
  const systemTasks = useSystemTasks(assistantId, tz);

  // Gates the consolidation/retrospective "Memory settings" link the same way
  // the schedules surface always has.
  const { data: hasMemoryOptOutCapability = false } = useQuery({
    queryKey: ["assistant-memory-opt-out-capability", assistantId],
    queryFn: async () => {
      const result = await getAssistantHealthz(assistantId);
      return result.ok && result.data.capabilities?.memoryOptOut === true;
    },
    retry: false,
    staleTime: 10_000,
  });
  // The memory toggle lives on the Memory tab of the flag-gated Developer
  // page, so the link is only offered when that destination is reachable.
  const settingsDeveloperNav =
    useAssistantFeatureFlagStore.use.settingsDeveloperNav();
  const canOpenMemorySettings =
    hasMemoryOptOutCapability && settingsDeveloperNav === true;

  const [createScheduleOpen, setCreateScheduleOpen] = useState(false);
  const selectedScheduleId = scheduleId ?? null;
  const [selectedSystemTaskKind, setSelectedSystemTaskKind] =
    useState<SystemTaskKind | null>(null);
  // The "Past" accordion open-state is lifted here so it survives the section
  // remount that happens when the detail drawer opens (the section reparents
  // into ResizablePanel). Otherwise opening a row collapses the accordion.
  const [pastSchedulesOpen, setPastSchedulesOpen] = useState(false);

  const handleSelectScheduleId = useCallback(
    (id: string | null) => {
      navigate(id ? routes.schedules.detail(id) : routes.schedules.root);
    },
    [navigate],
  );

  const selectedSchedule = selectedScheduleId
    ? (schedules.recurring.find((s) => s.id === selectedScheduleId) ??
      schedules.oneTime.find((s) => s.id === selectedScheduleId) ??
      schedules.pastOneTime.find((s) => s.id === selectedScheduleId) ??
      null)
    : null;

  // Drop the selection if the schedule disappears (e.g. after a delete/refetch,
  // or a deep link to a now-deleted id). Gate on `!isLoading` so a deep link to
  // `/schedules/:id` doesn't clear the URL before the list has loaded.
  useEffect(() => {
    if (selectedScheduleId && !schedules.isLoading && !selectedSchedule) {
      handleSelectScheduleId(null);
    }
  }, [
    selectedScheduleId,
    selectedSchedule,
    schedules.isLoading,
    handleSelectScheduleId,
  ]);

  const systemTaskAvailable =
    selectedSystemTaskKind === "heartbeat"
      ? systemTasks.heartbeatConfig != null
      : selectedSystemTaskKind === "consolidation"
        ? systemTasks.consolidationConfig?.available === true
        : selectedSystemTaskKind === "retrospective"
          ? systemTasks.retrospectiveConfig?.available === true
          : false;

  // Drop the selection if the task becomes unavailable (e.g. memory turned
  // off), but only once its config has loaded so we don't clear mid-fetch.
  useEffect(() => {
    if (
      selectedSystemTaskKind &&
      !systemTasks.isLoading &&
      !systemTaskAvailable
    ) {
      setSelectedSystemTaskKind(null);
    }
  }, [selectedSystemTaskKind, systemTaskAvailable, systemTasks.isLoading]);

  // The right pane shows one detail at a time — selecting a user schedule
  // closes any system-task detail, and vice versa.
  const handleSelectSchedule = useCallback(
    (id: string) => {
      setSelectedSystemTaskKind(null);
      handleSelectScheduleId(id);
    },
    [handleSelectScheduleId],
  );

  const handleSelectSystemTask = useCallback(
    (kind: SystemTaskKind) => {
      // Clear the focused schedule from the URL only when one is set, so
      // selecting a system task doesn't push a redundant history entry.
      if (selectedScheduleId) handleSelectScheduleId(null);
      setSelectedSystemTaskKind(kind);
    },
    [handleSelectScheduleId, selectedScheduleId],
  );

  const handleStartNewChat = useCallback(() => {
    navigateToNewConversation(navigate);
  }, [navigate]);

  const scheduleDetail = selectedSchedule ? (
    <ScheduleDetailPanel
      schedule={selectedSchedule}
      assistantId={assistantId}
      usage={schedules.usageForSchedule(selectedSchedule.id)}
      isMobile={isMobile}
      onClose={() => handleSelectScheduleId(null)}
      onDeleted={() => {
        handleSelectScheduleId(null);
        schedules.refetch();
      }}
    />
  ) : null;

  const systemTaskDetail =
    selectedSystemTaskKind && systemTaskAvailable ? (
      <SystemTaskDetailPanel
        kind={selectedSystemTaskKind}
        assistantId={assistantId}
        systemTasks={systemTasks}
        canOpenMemorySettings={canOpenMemorySettings}
        isMobile={isMobile}
        onClose={() => setSelectedSystemTaskKind(null)}
      />
    ) : null;

  const detail = scheduleDetail ?? systemTaskDetail;

  const section = (
    <SchedulesPanel
      recurring={schedules.recurring}
      oneTime={schedules.oneTime}
      pastOneTime={schedules.pastOneTime}
      usageForSchedule={schedules.usageForSchedule}
      isLoading={schedules.isLoading}
      isError={schedules.isError}
      refetch={schedules.refetch}
      onToggle={schedules.handleToggle}
      onSelectSchedule={handleSelectSchedule}
      selectedScheduleId={selectedScheduleId}
      onStartNewChat={handleStartNewChat}
      onCreateSchedule={() => setCreateScheduleOpen(true)}
      pastOpen={pastSchedulesOpen}
      onPastOpenChange={setPastSchedulesOpen}
      systemTasksSlot={
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
          onSelectHeartbeat={() => handleSelectSystemTask("heartbeat")}
          onSelectConsolidation={() => handleSelectSystemTask("consolidation")}
          onSelectRetrospective={() => handleSelectSystemTask("retrospective")}
        />
      }
    />
  );

  // On mobile the detail takes over the whole screen; on desktop it opens as
  // a drawer beside the list, under the layout's fixed heading.
  if (detail && isMobile) {
    return (
      <div
        className="fixed inset-0 z-30 bg-[var(--surface-overlay)]"
        style={{
          paddingTop:
            "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))",
          paddingBottom:
            "var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))",
        }}
      >
        {detail}
      </div>
    );
  }

  return (
    <>
      {detail && !isMobile ? (
        <ResizablePanel
          className="min-h-0 flex-1"
          storageKey="schedulesDetailDrawerWidth"
          defaultRightWidth={480}
          minLeftWidth={320}
          minRightWidth={400}
          hideDivider
          left={
            <div className="flex min-h-0 flex-1 flex-col pr-[var(--app-spacing-lg)]">
              {section}
            </div>
          }
          right={
            // `key` re-mounts the animated wrapper on each new selection so
            // the slide-in replays when switching between schedules and
            // system tasks (not just on the initial null → open transition).
            <div
              key={selectedScheduleId ?? selectedSystemTaskKind ?? undefined}
              className="home-detail-drawer"
            >
              {detail}
            </div>
          }
        />
      ) : (
        section
      )}
      <CreateScheduleModal
        isOpen={createScheduleOpen}
        assistantId={assistantId}
        onClose={() => setCreateScheduleOpen(false)}
        onCreated={() => {
          setCreateScheduleOpen(false);
          schedules.refetch();
        }}
      />
    </>
  );
}
