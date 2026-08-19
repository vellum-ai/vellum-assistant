import { useCallback, type TouchEvent as ReactTouchEvent } from "react";

import { useSwipeHorizontal } from "@/hooks/use-swipe-horizontal";

/**
 * Rows that own a horizontal drag for their own swipe actions. A conversation
 * row reveals Archive on a leftward swipe and Pin on a rightward one, and a
 * pinned app pill reveals Unpin; both sit inside the drawer, so the panel
 * gesture has to leave them alone or the two fight over every drag.
 *
 * `SwipeActionReveal` marks only its armed branch, so a row rendered without
 * actions (or on a fine pointer) claims nothing and the panel keeps the drag.
 */
const SWIPE_ACTION_ROW_SELECTOR = '[data-slot="swipe-action-row"]';

/**
 * Whether a touch beginning here belongs to a row's own swipe actions rather
 * than to the enclosing panel.
 */
export function startsOnSwipeActionRow(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  return target.closest(SWIPE_ACTION_ROW_SELECTOR) !== null;
}

/**
 * Clamp the live drag to the closing direction.
 *
 * The engine tracks both ways on its axis, but this panel rests against the
 * left edge with nowhere to go rightward: following a rightward drag would peel
 * it off that edge and expose the page behind it. Leftward travel passes
 * through, so the panel keeps tracking the finger toward the close.
 */
export function closingOffset(dragOffset: number): number {
  return Math.min(0, dragOffset);
}

interface UseSwipeCloseDrawerArgs {
  /** Whether the gesture is armed, i.e. the drawer is open. */
  enabled: boolean;
  /** Fired when a leftward swipe passes the commit threshold. */
  onClose: () => void;
}

interface UseSwipeCloseDrawerResult {
  /** Live leftward drag offset (px), never positive. 0 at rest. */
  dragOffset: number;
  /** True while a drag is in progress, so the caller can drop its transition. */
  isDragging: boolean;
  onTouchStart: (e: ReactTouchEvent) => void;
  onTouchMove: (e: ReactTouchEvent) => void;
  onTouchEnd: (e: ReactTouchEvent) => void;
  onTouchCancel: () => void;
}

/**
 * Swipe-to-close for the mobile navigation drawer, the counterpart to
 * `useEdgeSwipeDrawer`'s swipe-to-open.
 *
 * The two never overlap: the opening gesture is armed only while the drawer is
 * closed and hands the panel's transform back to React once it settles, and
 * this one is armed only while it is open. That is also why this is built on
 * `useSwipeHorizontal` rather than the opening gesture's engine, which listens
 * on `document`, arms only in the left half of the viewport, and rejects
 * leftward travel outright. Element handlers are what let a row inside the
 * drawer take a drag that started on it.
 *
 * A drag beginning on a row with its own swipe actions is left to that row: the
 * gesture never arms, so Archive and Pin behave inside the drawer exactly as
 * they do outside it. Everywhere else on the sheet, the header, the assistant
 * cluster, section headings, the gaps between cards and the space below the
 * list, a leftward swipe closes.
 */
export function useSwipeCloseDrawer({
  enabled,
  onClose,
}: UseSwipeCloseDrawerArgs): UseSwipeCloseDrawerResult {
  const swipe = useSwipeHorizontal({
    enabled,
    onSwipeLeft: onClose,
  });

  const { onTouchStart } = swipe;
  const handleTouchStart = useCallback(
    (event: ReactTouchEvent) => {
      if (startsOnSwipeActionRow(event.target)) {
        return;
      }
      onTouchStart(event);
    },
    [onTouchStart],
  );

  return {
    dragOffset: closingOffset(swipe.dragOffset),
    isDragging: swipe.isDragging,
    onTouchStart: handleTouchStart,
    onTouchMove: swipe.onTouchMove,
    onTouchEnd: swipe.onTouchEnd,
    onTouchCancel: swipe.onTouchCancel,
  };
}
