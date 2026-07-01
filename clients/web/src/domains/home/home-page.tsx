import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { getAssistantHealthz } from "@/assistant/api";
import { PageShell } from "@/components/page-shell";
import { CreateScheduleModal } from "@/domains/settings/components/create-schedule-modal";
import { SystemTasksSection } from "@/domains/settings/components/system-tasks-section";
import { useSystemTasks } from "@/domains/settings/hooks/use-system-tasks";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useSupportsBulkFeedStatus } from "@/lib/backwards-compat/bulk-feed-status";
import { useEffectiveTimezone } from "@/utils/use-effective-timezone";
import type { FeedItem, FeedItemStatus } from "@vellumai/assistant-api";
import { Button, ResizablePanel, Tabs } from "@vellumai/design-library";
import { HomeSchedulesPanel } from "./components/home-schedules-panel";
import { ScheduleDetailPanel } from "./components/schedule-detail-panel";
import { SystemTaskDetailPanel } from "./components/system-task-detail-panel";
import { HomeDetailPanel } from "./detail-panel/home-detail-panel";
import { HomeFeedList } from "./home-feed-list";
import { HomeTopHeader } from "./home-top-header";
import { excludeHighUrgency } from "./utils";
import { useHomeSchedulesData } from "./hooks/use-home-schedules-data";
import { useHomeFeedQuery } from "./hooks/use-home-feed-query";
import { useHomeStateQuery } from "./hooks/use-home-state-query";

import type { SystemTaskKind } from "@/domains/settings/types/schedules";

function HomePageSkeleton() {
  return (
    <div className="flex flex-col gap-[var(--app-spacing-xl)]">
      <div className="h-7 w-64 animate-pulse rounded-md bg-[var(--surface-lift)]" />

      <div className="flex flex-col gap-[var(--app-spacing-sm)]">
        {Array.from({ length: 4 }, (_, i) => (
          <div
            key={i}
            className="h-16 animate-pulse rounded-md bg-[var(--surface-lift)]"
          />
        ))}
      </div>
    </div>
  );
}

export interface HomePageProps {
  assistantId: string;
  validConversationIds: Set<string>;
  /** Active tab, derived from the URL by `HomePageRoute`. */
  activeTab: "schedules" | "notifications";
  /** Navigate to a tab's URL (`/home` or `/schedules`). */
  onTabChange: (tab: "schedules" | "notifications") => void;
  /** Focused schedule id from the URL (`/schedules/:scheduleId`), or null. */
  routeScheduleId: string | null;
  /** Navigate to focus a schedule (id) or clear it (null → `/schedules`). */
  onSelectScheduleId: (scheduleId: string | null) => void;
  onStartNewChat: () => void;
  onOpenConversation: (conversationId: string) => void;
}

/**
 * Scheduled-run notifications (`schedule.notify`) carry their originating
 * schedule id in `metadata.scheduleId`, letting the detail panel link back to
 * the schedule. Returns null for feed items not tied to a schedule.
 */
function getFeedItemScheduleId(item: FeedItem | null): string | null {
  const id = item?.metadata?.scheduleId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export function HomePage({
  assistantId,
  validConversationIds,
  activeTab,
  onTabChange,
  routeScheduleId,
  onSelectScheduleId,
  onStartNewChat,
  onOpenConversation,
}: HomePageProps) {
  const isMobile = useIsMobile();
  const tz = useEffectiveTimezone();
  const feedQuery = useHomeFeedQuery(assistantId);
  useHomeStateQuery(assistantId);
  const schedules = useHomeSchedulesData(assistantId);
  const systemTasks = useSystemTasks(assistantId, tz);

  // Gates the consolidation/retrospective "Memory settings" link the same way
  // the schedules surface always has.
  const { data: canOpenMemorySettings = false } = useQuery({
    queryKey: ["assistant-memory-opt-out-capability", assistantId],
    queryFn: async () => {
      const result = await getAssistantHealthz(assistantId);
      return result.ok && result.data.capabilities?.memoryOptOut === true;
    },
    retry: false,
    staleTime: 10_000,
  });

  const [createScheduleOpen, setCreateScheduleOpen] = useState(false);
  // `activeTab` and the focused schedule are URL-owned (see HomePageRoute);
  // selecting a schedule navigates rather than setting local state.
  const selectedScheduleId = routeScheduleId;
  const [selectedItem, setSelectedItem] = useState<FeedItem | null>(null);
  const [selectedSystemTaskKind, setSelectedSystemTaskKind] =
    useState<SystemTaskKind | null>(null);
  // Accordion open-states are lifted here so they survive the section remount
  // that happens when the detail drawer opens (the section reparents into
  // ResizablePanel). Otherwise opening a row collapses its own accordion.
  const [pastSchedulesOpen, setPastSchedulesOpen] = useState(false);
  const [archivedFeedOpen, setArchivedFeedOpen] = useState(false);
  const [dismissedFeedOpen, setDismissedFeedOpen] = useState(false);

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
      onSelectScheduleId(null);
    }
  }, [selectedScheduleId, selectedSchedule, schedules.isLoading, onSelectScheduleId]);

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
    if (selectedSystemTaskKind && !systemTasks.isLoading && !systemTaskAvailable) {
      setSelectedSystemTaskKind(null);
    }
  }, [selectedSystemTaskKind, systemTaskAvailable, systemTasks.isLoading]);

  // The right pane shows one detail at a time — selecting one kind (user
  // schedule, system task, or feed item) closes the others.
  const handleSelectSchedule = useCallback(
    (scheduleId: string) => {
      setSelectedItem(null);
      setSelectedSystemTaskKind(null);
      onSelectScheduleId(scheduleId);
    },
    [onSelectScheduleId],
  );

  const handleSelectSystemTask = useCallback(
    (kind: SystemTaskKind) => {
      setSelectedItem(null);
      // Clear the focused schedule from the URL only when one is set, so
      // selecting a system task doesn't push a redundant history entry.
      if (selectedScheduleId) onSelectScheduleId(null);
      setSelectedSystemTaskKind(kind);
    },
    [onSelectScheduleId, selectedScheduleId],
  );

  const handleSelectItem = useCallback(
    (item: FeedItem) => {
      // Feed items only render on the Notifications tab, where no schedule is
      // focused — nothing to clear from the URL here.
      setSelectedSystemTaskKind(null);
      if (item.status === "new") {
        setSelectedItem({ ...item, status: "seen" });
        feedQuery.updateStatus.mutate({ itemId: item.id, status: "seen" });
      } else {
        setSelectedItem(item);
      }
    },
    [feedQuery.updateStatus],
  );

  const handleCloseDetail = useCallback(() => {
    setSelectedItem(null);
  }, []);

  const handleDismissItem = useCallback(
    (itemId: string) => {
      feedQuery.updateStatus.mutate({ itemId, status: "dismissed" });
      if (selectedItem?.id === itemId) {
        setSelectedItem(null);
      }
    },
    [feedQuery.updateStatus, selectedItem?.id],
  );

  const handleRestoreItem = useCallback(
    (itemId: string) => {
      feedQuery.updateStatus.mutate({ itemId, status: "seen" });
      setSelectedItem((prev) =>
        prev?.id === itemId ? { ...prev, status: "seen" } : prev,
      );
    },
    [feedQuery.updateStatus],
  );

  const handleUpdateStatus = useCallback(
    (itemId: string, status: FeedItemStatus) => {
      feedQuery.updateStatus.mutate({ itemId, status });
      setSelectedItem((prev) =>
        prev?.id === itemId ? { ...prev, status } : prev,
      );
    },
    [feedQuery.updateStatus],
  );

  const handleGoToThread = useCallback(
    (conversationId: string) => {
      setSelectedItem(null);
      onOpenConversation(conversationId);
    },
    [onOpenConversation],
  );

  const feedItems = feedQuery.data?.items ?? [];
  const visibleFeedItems = excludeHighUrgency(
    feedItems.filter((i) => i.status !== "dismissed"),
  );
  const newCount = visibleFeedItems.filter((i) => i.status === "new").length;
  const activeCount = visibleFeedItems.length;
  const supportsBulkStatus = useSupportsBulkFeedStatus();

  const handleMarkAllRead = useCallback(() => {
    feedQuery.markAll.mutate({ from: ["new"], to: "seen" });
  }, [feedQuery.markAll]);

  const handleClearAll = useCallback(() => {
    feedQuery.markAll.mutate({
      from: ["new", "seen", "acted_on"],
      to: "dismissed",
    });
    setSelectedItem(null);
  }, [feedQuery.markAll]);

  // Link a scheduled-run notification back to its schedule, but only when that
  // schedule still exists in the loaded list (it may have since been deleted).
  const selectedItemScheduleId = getFeedItemScheduleId(selectedItem);
  const canViewSelectedItemSchedule =
    selectedItemScheduleId != null &&
    (schedules.recurring.some((s) => s.id === selectedItemScheduleId) ||
      schedules.oneTime.some((s) => s.id === selectedItemScheduleId) ||
      schedules.pastOneTime.some((s) => s.id === selectedItemScheduleId));

  const itemDetail = selectedItem ? (
    <HomeDetailPanel
      item={selectedItem}
      isMobile={isMobile}
      validConversationIds={validConversationIds}
      onClose={handleCloseDetail}
      onGoToThread={handleGoToThread}
      onUpdateStatus={handleUpdateStatus}
      onDismiss={handleDismissItem}
      onViewSchedule={
        canViewSelectedItemSchedule
          ? () => {
              // Navigating to the schedule's URL opens the Schedules tab and
              // focuses the drawer in one step.
              handleSelectSchedule(selectedItemScheduleId);
            }
          : undefined
      }
    />
  ) : null;

  const scheduleDetail = selectedSchedule ? (
    <ScheduleDetailPanel
      schedule={selectedSchedule}
      assistantId={assistantId}
      usage={schedules.usageForSchedule(selectedSchedule.id)}
      isMobile={isMobile}
      onClose={() => onSelectScheduleId(null)}
      onDeleted={() => {
        onSelectScheduleId(null);
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

  // The schedules tab shows either a user-schedule or a system-task detail.
  const scheduleAreaDetail = scheduleDetail ?? systemTaskDetail;

  // On mobile the detail takes over the whole screen (handled below). On
  // desktop it opens as a drawer nested under the active tab, so the Overview
  // title and the tabs stay fixed above it.
  const mobileDetail = itemDetail ?? scheduleAreaDetail;

  // `detailKey` re-mounts the animated wrapper on each new selection so the
  // slide-in replays when switching between schedules / system tasks / items
  // (not just on the initial null → open transition).
  const withDrawer = (
    section: ReactNode,
    detail: ReactNode,
    detailKey?: string,
  ) =>
    detail && !isMobile ? (
      <ResizablePanel
        className="min-h-0 flex-1"
        storageKey="homeDetailDrawerWidth"
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
          <div key={detailKey} className="home-detail-drawer">
            {detail}
          </div>
        }
      />
    ) : (
      section
    );

  const schedulesSection = (
    <HomeSchedulesPanel
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
      onStartNewChat={onStartNewChat}
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

  const notificationsSection = (
    <div className="flex min-h-0 flex-1 flex-col gap-[var(--app-spacing-lg)] overflow-y-auto">
      {feedQuery.isError ? (
        <div
          role="alert"
          className="rounded-md border border-[var(--system-negative-weak)] bg-[var(--system-negative-weak)] px-[var(--app-spacing-lg)] py-[var(--app-spacing-md)] text-[var(--system-negative-strong)]"
        >
          Couldn't load home feed
          {feedQuery.error instanceof Error
            ? `: ${feedQuery.error.message}`
            : "."}
        </div>
      ) : null}
      {supportsBulkStatus && (newCount > 0 || activeCount > 0) && (
        <div className="flex items-center justify-end gap-[var(--app-spacing-sm)]">
          {newCount > 0 && (
            <Button
              variant="ghost"
              size="compact"
              onClick={handleMarkAllRead}
              disabled={feedQuery.markAll.isPending}
            >
              Mark all as read
            </Button>
          )}
          {activeCount > 0 && (
            <Button
              variant="ghost"
              size="compact"
              onClick={handleClearAll}
              disabled={feedQuery.markAll.isPending}
            >
              Clear all
            </Button>
          )}
        </div>
      )}
      <HomeFeedList
        items={feedItems}
        selectedItemId={selectedItem?.id}
        validConversationIds={validConversationIds}
        onSelectItem={handleSelectItem}
        onDismissItem={handleDismissItem}
        onRestoreItem={handleRestoreItem}
        onToggleRead={handleUpdateStatus}
        onGoToThread={handleGoToThread}
        archivedOpen={archivedFeedOpen}
        onArchivedOpenChange={setArchivedFeedOpen}
        dismissedOpen={dismissedFeedOpen}
        onDismissedOpenChange={setDismissedFeedOpen}
      />
    </div>
  );

  // Schedules and notifications always live behind tabs (rather than a
  // side-by-side split), so each tab's content scrolls independently within
  // the bounded page height.
  const sections = (
    <Tabs.Root
      value={activeTab}
      onValueChange={(value) =>
        onTabChange(value as "schedules" | "notifications")
      }
      className="flex min-h-0 flex-1 flex-col"
    >
      <Tabs.List className="shrink-0">
        <Tabs.Trigger value="notifications">Notifications</Tabs.Trigger>
        <Tabs.Trigger value="schedules">Schedules</Tabs.Trigger>
      </Tabs.List>
      <Tabs.Panel
        value="notifications"
        className="mt-[var(--app-spacing-lg)] flex min-h-0 flex-1 flex-col"
      >
        {withDrawer(notificationsSection, itemDetail, selectedItem?.id)}
      </Tabs.Panel>
      <Tabs.Panel
        value="schedules"
        className="mt-[var(--app-spacing-lg)] flex min-h-0 flex-1 flex-col"
      >
        {withDrawer(
          schedulesSection,
          scheduleAreaDetail,
          selectedScheduleId ?? selectedSystemTaskKind ?? undefined,
        )}
      </Tabs.Panel>
    </Tabs.Root>
  );

  const feedContent = feedQuery.isLoading ? (
    <HomePageSkeleton />
  ) : (
    <div className="flex min-h-0 flex-1 flex-col gap-[var(--app-spacing-xl)]">
      {isMobile ? null : <HomeTopHeader />}
      {sections}
    </div>
  );

  if (mobileDetail && isMobile) {
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
        {mobileDetail}
      </div>
    );
  }

  return (
    <>
      <PageShell>{feedContent}</PageShell>
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
