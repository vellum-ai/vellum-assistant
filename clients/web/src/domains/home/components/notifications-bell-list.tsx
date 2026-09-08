import type { Ref, UIEventHandler } from "react";

import type { FeedItem, FeedItemStatus } from "@vellumai/assistant-api";

import { HomeRecapRow, type HomeRecapRowDecision } from "../home-recap-row";
import { resolveThreadName } from "../utils";

/** No titles known: every row falls back to its source label, or to nothing. */
const NO_CONVERSATION_TITLES: ReadonlyMap<string, string> = new Map();

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
  /**
   * Titles of the conversations the items came from, by conversation id, so
   * each row can name its thread. Empty until the conversation lists load.
   */
  conversationTitles?: ReadonlyMap<string, string>;
  /** Restores the scroll offset the bell parked while a detail was open. */
  scrollRef?: Ref<HTMLDivElement>;
  onScroll?: UIEventHandler<HTMLDivElement>;
  onSelect: (item: FeedItem) => void;
  onDismiss: (itemId: string) => void;
  onToggleRead: (itemId: string, newStatus: FeedItemStatus) => void;
  /** Decides a pending approval from its row; see `HomeRecapRow`. */
  onDecide?: (item: FeedItem, decision: HomeRecapRowDecision) => void;
  isDecisionPending?: boolean;
}

/**
 * The notifications the bell shows before one is opened: a scrolling stack
 * of rows divided by rules, newest first under whatever is waiting on the
 * user.
 *
 * The empty and failed-load states belong to the bell, which decides
 * between them and this list.
 */
export function NotificationsBellList({
  items,
  maxHeight,
  conversationTitles = NO_CONVERSATION_TITLES,
  scrollRef,
  onScroll,
  onSelect,
  onDismiss,
  onToggleRead,
  onDecide,
  isDecisionPending = false,
}: NotificationsBellListProps) {
  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      data-testid="notifications-bell-list"
      style={{ maxHeight }}
      className="flex flex-col gap-[var(--app-spacing-md)] overflow-y-auto px-[var(--app-spacing-lg)] pt-[var(--app-spacing-lg)]"
    >
      {items.map((item) => (
        <HomeRecapRow
          key={item.id}
          item={item}
          threadName={resolveThreadName(item, conversationTitles)}
          onSelect={onSelect}
          onDismiss={onDismiss}
          onToggleRead={onToggleRead}
          onDecide={onDecide}
          isDecisionPending={isDecisionPending}
        />
      ))}
    </div>
  );
}
