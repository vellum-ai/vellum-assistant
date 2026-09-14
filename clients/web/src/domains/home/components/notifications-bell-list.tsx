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
  /**
   * Requests with a decision in flight from any surface, whose rows hold
   * their buttons inert until it lands.
   */
  pendingRequestIds?: ReadonlySet<string>;
  /**
   * Requests already decided this session, whose rows keep their buttons
   * down until the feed projects the settled request.
   */
  decidedRequestIds?: ReadonlySet<string>;
}

const NO_REQUESTS: ReadonlySet<string> = new Set();

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
  pendingRequestIds = NO_REQUESTS,
  decidedRequestIds = NO_REQUESTS,
}: NotificationsBellListProps) {
  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      data-testid="notifications-bell-list"
      style={{ maxHeight }}
      // The colour the rows sit on: the sheet and the popover that hold this
      // list both paint `--surface-lift`. A row is transparent, and the swipe
      // wrapper backs it with this so a swiped row covers the action behind
      // it instead of showing it through.
      className="flex flex-col gap-[var(--app-spacing-md)] overflow-y-auto px-[var(--app-spacing-lg)] pt-[var(--app-spacing-lg)] [--swipe-item-surface:var(--surface-lift)]"
    >
      {/* The rule between rows lives here rather than on the row, so the
          last row can drop it: the panel's footer draws its own rule right
          underneath, and two would double up. */}
      {items.map((item) => (
        <div
          key={item.id}
          className="border-b border-[var(--border-subtle)] pb-[var(--app-spacing-md)] last:border-b-0"
        >
          <HomeRecapRow
            item={item}
            threadName={resolveThreadName(item, conversationTitles)}
            onSelect={onSelect}
            onDismiss={onDismiss}
            onToggleRead={onToggleRead}
            onDecide={onDecide}
            isDecisionPending={
              isDecisionPending ||
              (item.guardianRequest !== undefined &&
                pendingRequestIds.has(item.guardianRequest.requestId))
            }
            isDecided={
              item.guardianRequest !== undefined &&
              decidedRequestIds.has(item.guardianRequest.requestId)
            }
          />
        </div>
      ))}
    </div>
  );
}
