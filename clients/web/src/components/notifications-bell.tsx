import { Bell } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";

import { HomeRecapRow } from "@/domains/home/home-recap-row";
import { useHomeFeedQuery } from "@/domains/home/hooks/use-home-feed-query";
import { excludeHighUrgency, sortFeedItems } from "@/domains/home/utils";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useSupportsBulkFeedStatus } from "@/lib/backwards-compat/bulk-feed-status";
import { routes } from "@/utils/routes";
import type { FeedItem } from "@vellumai/assistant-api";
import {
    BottomSheet,
    Button,
    Popover,
    Tooltip,
    Typography,
} from "@vellumai/design-library";

/**
 * Router state consumed by `HomePageRoute`: opening a notification from the
 * bell lands on the Activity page with that item's detail drawer open.
 */
export interface ActivityLocationState {
  feedItemId?: string;
}

// Caps the visible list at roughly five rows (48px rows + 4px gaps);
// older notifications stay reachable by scrolling.
const LIST_MAX_HEIGHT_CLASS = "max-h-[280px]";

/**
 * Notification bell for the top nav: a ghost icon button with an unread dot
 * that opens the latest notifications in a popover (desktop) or bottom sheet
 * (mobile) — the same split the sidebar preferences menu uses. Rows reuse
 * `HomeRecapRow`, so mark-read and dismiss work inline; clicking a row (or
 * "View all") continues to the full Activity page.
 */
export function NotificationsBell({
  assistantId,
}: {
  assistantId: string | null;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const feedQuery = useHomeFeedQuery(assistantId);
  const supportsBulkStatus = useSupportsBulkFeedStatus();

  const items = feedQuery.data?.items ?? [];
  // Same visibility rules as the Activity page: dismissed items are hidden
  // and high-urgency items surface through their own channels.
  const visibleItems = sortFeedItems(
    excludeHighUrgency(items.filter((item) => item.status !== "dismissed")),
  );
  const newItems = visibleItems.filter((item) => item.status === "new");
  const hasUnread = newItems.length > 0;

  const openActivityPage = (item?: FeedItem) => {
    setIsOpen(false);
    void navigate(routes.home, {
      state: item
        ? ({ feedItemId: item.id } satisfies ActivityLocationState)
        : undefined,
    });
  };

  const handleSelectItem = (item: FeedItem) => {
    if (item.status === "new") {
      feedQuery.updateStatus.mutate({ itemId: item.id, status: "seen" });
    }
    openActivityPage(item);
  };

  const handleMarkAllRead = () => {
    feedQuery.markAll.mutate({
      from: ["new"],
      to: "seen",
      ids: newItems.map((item) => item.id),
    });
  };

  const handleClearAll = () => {
    feedQuery.markAll.mutate({
      from: ["new", "seen", "acted_on"],
      to: "dismissed",
      ids: visibleItems.map((item) => item.id),
    });
  };

  // No `tooltip` prop on the Button: it would wrap the button in a Tooltip
  // component, breaking the popover/sheet Trigger's `asChild` prop merge.
  // Desktop nests Tooltip *around* the Trigger instead (the
  // CollapsedGroupIcon pattern); mobile is touch, so no tooltip.
  const trigger = (
    <Button
      variant="ghost"
      iconOnly={
        <span className="relative flex" aria-hidden>
          <Bell />
          {hasUnread ? (
            <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-[var(--system-negative-strong)]" />
          ) : null}
        </span>
      }
      aria-label={hasUnread ? "Notifications (unread)" : "Notifications"}
    />
  );

  const list =
    visibleItems.length === 0 ? (
      <Typography
        variant="body-medium-lighter"
        className="px-[var(--app-spacing-lg)] py-[var(--app-spacing-xl)] text-center text-[var(--content-tertiary)]"
      >
        {feedQuery.isError
          ? "Couldn't load notifications."
          : "No notifications yet."}
      </Typography>
    ) : (
      <div
        className={`flex flex-col gap-[var(--app-spacing-xs)] overflow-y-auto ${
          isMobile ? "max-h-[60dvh]" : LIST_MAX_HEIGHT_CLASS
        }`}
      >
        {visibleItems.map((item) => (
          <HomeRecapRow
            key={item.id}
            item={item}
            onSelect={handleSelectItem}
            onDismiss={(itemId) =>
              feedQuery.updateStatus.mutate({ itemId, status: "dismissed" })
            }
            onToggleRead={(itemId, status) =>
              feedQuery.updateStatus.mutate({ itemId, status })
            }
          />
        ))}
      </div>
    );

  const panel = (
    <div className="flex min-w-0 flex-col">
      <div className="flex items-center justify-between gap-2 pb-[var(--app-spacing-sm)] pl-[var(--app-spacing-md)]">
        <Typography
          variant="body-medium-default"
          as="h2"
          className="text-[var(--content-default)]"
        >
          Notifications
        </Typography>
        <Button variant="ghost" size="compact" onClick={() => openActivityPage()}>
          View all
        </Button>
      </div>

      {list}

      {supportsBulkStatus && visibleItems.length > 0 ? (
        <div className="mt-[var(--app-spacing-sm)] flex items-center justify-end gap-[var(--app-spacing-sm)] border-t border-[var(--border-base)] pt-[var(--app-spacing-sm)]">
          {hasUnread ? (
            <Button
              variant="ghost"
              size="compact"
              onClick={handleMarkAllRead}
              disabled={feedQuery.markAll.isPending}
            >
              Mark all as read
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="compact"
            onClick={handleClearAll}
            disabled={feedQuery.markAll.isPending}
          >
            Clear all
          </Button>
        </div>
      ) : null}
    </div>
  );

  if (isMobile) {
    return (
      <BottomSheet.Root open={isOpen} onOpenChange={setIsOpen}>
        <BottomSheet.Trigger asChild>{trigger}</BottomSheet.Trigger>
        <BottomSheet.Content className="max-h-[85dvh]">
          <BottomSheet.Header className="sr-only">
            <BottomSheet.Title>Notifications</BottomSheet.Title>
          </BottomSheet.Header>
          <BottomSheet.Body className="pt-0">{panel}</BottomSheet.Body>
        </BottomSheet.Content>
      </BottomSheet.Root>
    );
  }

  return (
    <Popover.Root open={isOpen} onOpenChange={setIsOpen}>
      <Tooltip content="Notifications">
        <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      </Tooltip>
      <Popover.Content
        side="bottom"
        align="end"
        sideOffset={8}
        tabIndex={-1}
        onOpenAutoFocus={(event) => {
          // Focus the panel itself so the first row doesn't light up (and
          // show its hover actions) before the user interacts.
          const content = event.currentTarget as HTMLElement | null;
          event.preventDefault();
          content?.focus();
        }}
        className="w-96 max-w-[calc(100vw-2rem)] rounded-lg p-2"
      >
        {panel}
      </Popover.Content>
    </Popover.Root>
  );
}
