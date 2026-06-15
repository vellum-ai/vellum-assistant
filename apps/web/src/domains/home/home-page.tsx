import { useCallback, useEffect, useState } from "react";

import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useIsMobile } from "@/hooks/use-is-mobile";
import type { FeedItem, FeedItemStatus } from "@vellumai/assistant-api";
import { ResizablePanel } from "@vellumai/design-library";
import { HomeSchedulesPanel } from "./components/home-schedules-panel";
import { ScheduleDetailPanel } from "./components/schedule-detail-panel";
import { HomeDetailPanel } from "./detail-panel/home-detail-panel";
import { HomeFeedList } from "./home-feed-list";
import { HomeGreetingHeader } from "./home-greeting-header";
import { HomeTopHeader } from "./home-top-header";
import { useHomeSchedulesData } from "./hooks/use-home-schedules-data";
import { useHomeFeedQuery } from "./hooks/use-home-feed-query";
import { useHomeStateQuery } from "./hooks/use-home-state-query";

function HomePageSkeleton() {
  return (
    <div className="flex flex-col gap-[var(--app-spacing-xl)]">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-[var(--app-spacing-md)]">
          <div className="size-9 animate-pulse rounded-full bg-[var(--surface-lift)]" />
          <div className="h-7 w-64 animate-pulse rounded-md bg-[var(--surface-lift)]" />
        </div>
        <div className="h-9 w-28 animate-pulse rounded-md bg-[var(--surface-lift)]" />
      </div>

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
  onStartNewChat: () => void;
  onOpenConversation: (conversationId: string) => void;
}

export function HomePage({
  assistantId,
  validConversationIds,
  onStartNewChat,
  onOpenConversation,
}: HomePageProps) {
  const isMobile = useIsMobile();
  const avatar = useAssistantAvatar(assistantId);
  const feedQuery = useHomeFeedQuery(assistantId);
  useHomeStateQuery(assistantId);
  const schedules = useHomeSchedulesData(assistantId);

  const [selectedItem, setSelectedItem] = useState<FeedItem | null>(null);
  const [selectedScheduleId, setSelectedScheduleId] = useState<string | null>(
    null,
  );

  const selectedSchedule = selectedScheduleId
    ? (schedules.recurring.find((s) => s.id === selectedScheduleId) ??
      schedules.oneTime.find((s) => s.id === selectedScheduleId) ??
      null)
    : null;

  // Drop the selection if the schedule disappears (e.g. after a delete/refetch).
  useEffect(() => {
    if (selectedScheduleId && !selectedSchedule) setSelectedScheduleId(null);
  }, [selectedScheduleId, selectedSchedule]);

  // The right pane shows one detail at a time — selecting a schedule closes any
  // open feed item, and vice versa.
  const handleSelectSchedule = useCallback((scheduleId: string) => {
    setSelectedItem(null);
    setSelectedScheduleId(scheduleId);
  }, []);

  const handleSelectItem = useCallback(
    (item: FeedItem) => {
      setSelectedScheduleId(null);
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

  const feedContent = feedQuery.isLoading ? (
    <HomePageSkeleton />
  ) : (
    <>
      <HomeTopHeader
        avatarComponents={avatar.components}
        avatarTraits={avatar.traits}
        avatarImageUrl={avatar.customImageUrl}
      />
      <HomeSchedulesPanel
        recurring={schedules.recurring}
        oneTime={schedules.oneTime}
        usageForSchedule={schedules.usageForSchedule}
        isLoading={schedules.isLoading}
        isError={schedules.isError}
        refetch={schedules.refetch}
        onToggle={schedules.handleToggle}
        onSelectSchedule={handleSelectSchedule}
        selectedScheduleId={selectedScheduleId}
      />
      <HomeGreetingHeader
        greeting={feedQuery.data?.contextBanner?.greeting}
        isMobile={isMobile}
        onStartNewChat={onStartNewChat}
      />
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
      <HomeFeedList
        items={feedQuery.data?.items ?? []}
        selectedItemId={selectedItem?.id}
        validConversationIds={validConversationIds}
        onSelectItem={handleSelectItem}
        onDismissItem={handleDismissItem}
        onRestoreItem={handleRestoreItem}
        onToggleRead={handleUpdateStatus}
        onGoToThread={handleGoToThread}
      />
    </>
  );

  const rightPanel = selectedItem ? (
    <HomeDetailPanel
      item={selectedItem}
      isMobile={isMobile}
      validConversationIds={validConversationIds}
      onClose={handleCloseDetail}
      onGoToThread={handleGoToThread}
      onUpdateStatus={handleUpdateStatus}
      onDismiss={handleDismissItem}
    />
  ) : selectedSchedule ? (
    <ScheduleDetailPanel
      schedule={selectedSchedule}
      assistantId={assistantId}
      usage={schedules.usageForSchedule(selectedSchedule.id)}
      isMobile={isMobile}
      onClose={() => setSelectedScheduleId(null)}
      onDeleted={() => {
        setSelectedScheduleId(null);
        schedules.refetch();
      }}
    />
  ) : null;

  if (rightPanel && isMobile) {
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
        {rightPanel}
      </div>
    );
  }

  if (rightPanel && !isMobile) {
    return (
      <ResizablePanel
        storageKey="homeDetailPanelWidth"
        defaultLeftPercent={50}
        minLeftWidth={400}
        minRightWidth={320}
        left={
          <div className="flex h-full flex-col gap-[var(--app-spacing-xl)] overflow-y-auto px-[var(--app-spacing-xl)] py-[var(--app-spacing-xxl)]">
            {feedContent}
          </div>
        }
        right={rightPanel}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-[960px] px-[var(--app-spacing-xl)] py-[var(--app-spacing-xxl)]">
        <div className="flex flex-col gap-[var(--app-spacing-xl)]">
          {feedContent}
        </div>
      </div>
    </div>
  );
}
