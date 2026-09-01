import type { Ref, UIEventHandler } from "react";

import type { FeedItem, FeedItemStatus } from "@vellumai/assistant-api";

import { HomeRecapRow } from "../home-recap-row";

export interface NotificationsBellListProps {
  /**
   * Visible feed items, already filtered and sorted: a request waiting on
   * the user sorts first, the rest by recency.
   */
  items: FeedItem[];
  /**
   * Cap on the list's height. A feed shorter than the cap draws a shorter
   * panel; a longer one scrolls inside it.
   */
  maxHeight: string;
  /** Restores the scroll offset the bell parked while a detail was open. */
  scrollRef?: Ref<HTMLDivElement>;
  onScroll?: UIEventHandler<HTMLDivElement>;
  onSelect: (item: FeedItem) => void;
  onDismiss: (itemId: string) => void;
  onToggleRead: (itemId: string, newStatus: FeedItemStatus) => void;
}

/**
 * The notifications the bell shows before one is opened: a scrolling stack
 * of compact rows, newest first under whatever is waiting on the user.
 *
 * The empty and failed-load states belong to the bell, which decides
 * between them and this list.
 */
export function NotificationsBellList({
  items,
  maxHeight,
  scrollRef,
  onScroll,
  onSelect,
  onDismiss,
  onToggleRead,
}: NotificationsBellListProps) {
  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      data-testid="notifications-bell-list"
      style={{ maxHeight }}
      className="flex flex-col gap-[var(--app-spacing-sm)] overflow-y-auto"
    >
      {items.map((item) => (
        <HomeRecapRow
          key={item.id}
          item={item}
          density="compact"
          onSelect={onSelect}
          onDismiss={onDismiss}
          onToggleRead={onToggleRead}
        />
      ))}
    </div>
  );
}
