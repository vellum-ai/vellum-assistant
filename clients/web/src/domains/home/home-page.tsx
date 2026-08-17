import { useCallback, useEffect, useState } from "react";

import { DetailDrawer, MobileDetailOverlay } from "@/components/detail-drawer";
import { PageShell } from "@/components/page-shell";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useTranslation } from "@/i18n";
import { useSupportsBulkFeedStatus } from "@/lib/backwards-compat/bulk-feed-status";
import type { FeedItem, FeedItemStatus } from "@vellumai/assistant-api";
import { Button, Skeleton } from "@vellumai/design-library";
import { HomeDetailPanel } from "./detail-panel/home-detail-panel";
import { HomeFeedList } from "./home-feed-list";
import { HomeTopHeader } from "./home-top-header";
import { clearAllArgs, getVisibleFeedItems, markAllReadArgs } from "./utils";
import { useFeedItemEntityLinks } from "./hooks/use-feed-item-entity-links";
import { useHomeFeedQuery } from "./hooks/use-home-feed-query";
import { useHomeStateQuery } from "./hooks/use-home-state-query";

function HomePageSkeleton() {
  return (
    <div className="flex flex-col gap-[var(--app-spacing-xl)]">
      <Skeleton className="h-7 w-64 rounded-md" />

      <div className="flex flex-col gap-[var(--app-spacing-sm)]">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-16 rounded-md" />
        ))}
      </div>
    </div>
  );
}

export interface HomePageProps {
  assistantId: string;
  validConversationIds: Set<string>;
  onOpenConversation: (conversationId: string) => void;
  /** Navigate to an app path. Used by the detail panel's entity links, which
   *  build their own targets (a schedule's detail, a skill's detail). */
  onNavigate: (to: string) => void;
  /** Feed item to open on arrival (routed here from the notifications
   *  bell); its detail drawer opens once the feed has loaded. */
  initialFeedItemId?: string | null;
  /** Identity of the navigation that delivered `initialFeedItemId`
   *  (`location.key`). Consumption is tracked per navigation, so clicking
   *  the same notification again re-opens its drawer. */
  navigationKey?: string;
  /** Called once `initialFeedItemId` has been handled, so the route can
   *  strip it from history state — otherwise a reload or Back to this entry
   *  would replay a drawer the user already closed. */
  onInitialFeedItemConsumed?: () => void;
}

export function HomePage({
  assistantId,
  validConversationIds,
  onOpenConversation,
  onNavigate,
  initialFeedItemId,
  navigationKey,
  onInitialFeedItemConsumed,
}: HomePageProps) {
  const { t } = useTranslation("home");
  const isMobile = useIsMobile();
  const feedQuery = useHomeFeedQuery(assistantId);
  useHomeStateQuery(assistantId);

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

  // One-shot per navigation: when routed here from the notifications bell,
  // open that item's detail drawer once the feed has loaded. Keyed on the
  // navigation (`location.key`), not the item id, so re-clicking the same
  // notification works; the consumed-state callback then strips the id from
  // history state so reload/Back don't replay a drawer the user closed.
  const [consumedNavigationKey, setConsumedNavigationKey] = useState<
    string | null
  >(null);
  useEffect(() => {
    if (
      !initialFeedItemId ||
      navigationKey === consumedNavigationKey ||
      feedQuery.isLoading
    ) {
      return;
    }
    setConsumedNavigationKey(navigationKey ?? null);
    const item = feedItems.find((i) => i.id === initialFeedItemId);
    // A since-dismissed item's drawer must not pop open unprompted.
    if (item && item.status !== "dismissed") {
      handleSelectItem(item);
    }
    onInitialFeedItemConsumed?.();
  }, [
    initialFeedItemId,
    navigationKey,
    consumedNavigationKey,
    feedQuery.isLoading,
    feedItems,
    handleSelectItem,
    onInitialFeedItemConsumed,
  ]);

  const visibleFeedItems = getVisibleFeedItems(feedItems);
  const newCount = visibleFeedItems.filter((i) => i.status === "new").length;
  const activeCount = visibleFeedItems.length;
  const supportsBulkStatus = useSupportsBulkFeedStatus();

  const handleMarkAllRead = useCallback(() => {
    feedQuery.markAll.mutate(markAllReadArgs(visibleFeedItems));
  }, [feedQuery.markAll, visibleFeedItems]);

  const handleClearAll = useCallback(() => {
    feedQuery.markAll.mutate(clearAllArgs(visibleFeedItems));
    setSelectedItem(null);
  }, [feedQuery.markAll, visibleFeedItems]);

  // Links from the open notification to what it is about: the schedule that
  // produced a scheduled run, the skill a background pass rewrote. The lists
  // these are validated against load with the page rather than with the
  // detail, so by the time a row is clicked they are warm; a link still
  // waiting on one is held back rather than rendered and then withdrawn.
  const { links: entityLinks, isPending: areEntityLinksPending } =
    useFeedItemEntityLinks(selectedItem, assistantId, true);

  const itemDetail = selectedItem ? (
    <HomeDetailPanel
      item={selectedItem}
      isMobile={isMobile}
      validConversationIds={validConversationIds}
      onClose={handleCloseDetail}
      onGoToThread={handleGoToThread}
      onUpdateStatus={handleUpdateStatus}
      onDismiss={handleDismissItem}
      entityLinks={areEntityLinksPending ? [] : entityLinks}
      onNavigate={onNavigate}
    />
  ) : null;

  const notificationsSection = (
    <div className="flex min-h-0 flex-1 flex-col gap-[var(--app-spacing-lg)] overflow-y-auto">
      {feedQuery.isError ? (
        <div
          role="alert"
          className="rounded-md border border-[var(--system-negative-weak)] bg-[var(--system-negative-weak)] px-[var(--app-spacing-lg)] py-[var(--app-spacing-md)] text-[var(--system-negative-strong)]"
        >
          {feedQuery.error instanceof Error
            ? t("homePage.loadFailedDetail", {
                message: feedQuery.error.message,
              })
            : t("homePage.loadFailed")}
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
              {t("actions.markAllAsRead")}
            </Button>
          )}
          {activeCount > 0 && (
            <Button
              variant="ghost"
              size="compact"
              onClick={handleClearAll}
              disabled={feedQuery.markAll.isPending}
            >
              {t("actions.clearAll")}
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
  // stays fixed above it.
  const sections =
    itemDetail && !isMobile ? (
      <DetailDrawer
        storageKey="homeDetailDrawerWidth"
        detailKey={selectedItem?.id}
        section={notificationsSection}
        detail={itemDetail}
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
    return <MobileDetailOverlay>{itemDetail}</MobileDetailOverlay>;
  }

  return <PageShell>{feedContent}</PageShell>;
}
