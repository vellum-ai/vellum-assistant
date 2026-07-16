import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";

import { PageShell } from "@/components/page-shell";
import { fetchSchedules } from "@/domains/settings/api/schedules";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useSupportsBulkFeedStatus } from "@/lib/backwards-compat/bulk-feed-status";
import { schedulesGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import type { FeedItem, FeedItemStatus } from "@vellumai/assistant-api";
import { Button, ResizablePanel } from "@vellumai/design-library";
import { HomeDetailPanel } from "./detail-panel/home-detail-panel";
import { HomeFeedList } from "./home-feed-list";
import { HomeTopHeader } from "./home-top-header";
import { excludeHighUrgency } from "./utils";
import { useHomeFeedQuery } from "./hooks/use-home-feed-query";
import { useHomeStateQuery } from "./hooks/use-home-state-query";

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
  onOpenConversation: (conversationId: string) => void;
  /** Navigate to a schedule's detail on the Schedules page
   *  (`/assistant/schedules/:scheduleId`). */
  onViewSchedule: (scheduleId: string) => void;
  /** Feed item to open on arrival (routed here from the notifications
   *  bell); its detail drawer opens once the feed has loaded. */
  initialFeedItemId?: string | null;
}

/**
 * Scheduled-run notifications (`schedule.notify`) carry their originating
 * schedule id in `metadata.scheduleId`, letting the detail panel link to
 * the schedule. Returns null for feed items not tied to a schedule.
 */
function getFeedItemScheduleId(item: FeedItem | null): string | null {
  const id = item?.metadata?.scheduleId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export function HomePage({
  assistantId,
  validConversationIds,
  onOpenConversation,
  onViewSchedule,
  initialFeedItemId,
}: HomePageProps) {
  const isMobile = useIsMobile();
  const feedQuery = useHomeFeedQuery(assistantId);
  useHomeStateQuery(assistantId);

  // Schedules moved to their own page (`/assistant/schedules`), but the feed
  // still links scheduled-run notifications to their schedule. This query
  // shares its key (and cache) with the Schedules page and only gates whether
  // the "View schedule" link is offered — the schedule may have been deleted.
  const { data: schedules } = useQuery({
    queryKey: schedulesGetQueryKey({ path: { assistant_id: assistantId } }),
    queryFn: () => fetchSchedules(assistantId),
    staleTime: 10_000,
  });

  const [selectedItem, setSelectedItem] = useState<FeedItem | null>(null);
  // Accordion open-states are lifted here so they survive the section remount
  // that happens when the detail drawer opens (the section reparents into
  // ResizablePanel). Otherwise opening a row collapses its own accordion.
  const [archivedFeedOpen, setArchivedFeedOpen] = useState(false);
  const [dismissedFeedOpen, setDismissedFeedOpen] = useState(false);

  const handleSelectItem = useCallback(
    (item: FeedItem) => {
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

  // One-shot: when routed here from the notifications bell, open that item's
  // detail drawer once the feed has loaded. Tracking the consumed id keeps a
  // later refetch from re-opening a drawer the user has since closed.
  const [consumedInitialItemId, setConsumedInitialItemId] = useState<
    string | null
  >(null);
  useEffect(() => {
    if (
      !initialFeedItemId ||
      initialFeedItemId === consumedInitialItemId ||
      feedQuery.isLoading
    ) {
      return;
    }
    setConsumedInitialItemId(initialFeedItemId);
    const item = feedItems.find((i) => i.id === initialFeedItemId);
    if (item) handleSelectItem(item);
  }, [
    initialFeedItemId,
    consumedInitialItemId,
    feedQuery.isLoading,
    feedItems,
    handleSelectItem,
  ]);

  const visibleFeedItems = excludeHighUrgency(
    feedItems.filter((i) => i.status !== "dismissed"),
  );
  const newCount = visibleFeedItems.filter((i) => i.status === "new").length;
  const activeCount = visibleFeedItems.length;
  const supportsBulkStatus = useSupportsBulkFeedStatus();

  const handleMarkAllRead = useCallback(() => {
    feedQuery.markAll.mutate({
      from: ["new"],
      to: "seen",
      ids: visibleFeedItems.filter((i) => i.status === "new").map((i) => i.id),
    });
  }, [feedQuery.markAll, visibleFeedItems]);

  const handleClearAll = useCallback(() => {
    feedQuery.markAll.mutate({
      from: ["new", "seen", "acted_on"],
      to: "dismissed",
      ids: visibleFeedItems.map((i) => i.id),
    });
    setSelectedItem(null);
  }, [feedQuery.markAll, visibleFeedItems]);

  // Link a scheduled-run notification to its schedule, but only when that
  // schedule still exists in the loaded list (it may have since been deleted).
  const selectedItemScheduleId = getFeedItemScheduleId(selectedItem);
  const canViewSelectedItemSchedule =
    selectedItemScheduleId != null &&
    (schedules ?? []).some((s) => s.id === selectedItemScheduleId);

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
          ? () => onViewSchedule(selectedItemScheduleId)
          : undefined
      }
    />
  ) : null;

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

  // On mobile the detail takes over the whole screen (handled below). On
  // desktop it opens as a drawer beside the feed, so the Activity title
  // stays fixed above it. `key` re-mounts the animated wrapper on each new
  // selection so the slide-in replays when switching between items.
  const sections =
    itemDetail && !isMobile ? (
      <ResizablePanel
        className="min-h-0 flex-1"
        storageKey="homeDetailDrawerWidth"
        defaultRightWidth={480}
        minLeftWidth={320}
        minRightWidth={400}
        hideDivider
        left={
          <div className="flex min-h-0 flex-1 flex-col pr-[var(--app-spacing-lg)]">
            {notificationsSection}
          </div>
        }
        right={
          <div key={selectedItem?.id} className="home-detail-drawer">
            {itemDetail}
          </div>
        }
      />
    ) : (
      notificationsSection
    );

  const feedContent = feedQuery.isLoading ? (
    <HomePageSkeleton />
  ) : (
    <div className="flex min-h-0 flex-1 flex-col gap-[var(--app-spacing-xl)]">
      {isMobile ? null : <HomeTopHeader />}
      {sections}
    </div>
  );

  if (itemDetail && isMobile) {
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
        {itemDetail}
      </div>
    );
  }

  return <PageShell>{feedContent}</PageShell>;
}
