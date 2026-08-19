import {
  useEffect,
  useState,
  type RefObject,
  type TouchEvent as ReactTouchEvent,
} from "react";

import {
  EDGE_SWIPE_FALLBACK_SLACK_MS,
  EDGE_SWIPE_SLIDE_MS,
} from "@/hooks/edge-swipe-motion";
import { useEdgeSwipeDrawer } from "@/hooks/use-edge-swipe-drawer";
import { useSwipeCloseDrawer } from "@/hooks/use-swipe-close-drawer";
import { useEdgeSwipeArbiterStore } from "@/stores/edge-swipe-arbiter-store";

interface UseChatLayoutDrawerGesturesArgs {
  /** Ref to the sliding panel, whose `translateX` both gestures move. */
  panelRef: RefObject<HTMLElement | null>;
  /** Whether the mobile layout is in play; the drawer exists nowhere else. */
  isMobile: boolean;
  /** Whether the drawer is open. */
  open: boolean;
  /** Fired when a left-edge swipe commits open. */
  onOpen: () => void;
  /** Fired when a leftward swipe on the panel commits closed. */
  onClose: () => void;
}

interface UseChatLayoutDrawerGesturesResult {
  /** Whether the panel belongs in the DOM: open, dragging in, or exiting. */
  present: boolean;
  /** True while the panel is mounted only to finish its closing slide. */
  exiting: boolean;
  /** Live leftward drag offset (px) of the closing gesture, never positive. */
  dragOffset: number;
  /** True while a closing drag runs, so the caller drops its transition. */
  isDragging: boolean;
  onTouchStart: (e: ReactTouchEvent) => void;
  onTouchMove: (e: ReactTouchEvent) => void;
  onTouchEnd: (e: ReactTouchEvent) => void;
  onTouchCancel: () => void;
}

/**
 * The mobile drawer's two swipe gestures and the presence state they need.
 *
 * Swipe-to-open (`useEdgeSwipeDrawer`) tracks the panel in from the left edge
 * while the drawer is closed; swipe-to-close (`useSwipeCloseDrawer`) tracks it
 * back out while it is open. The two are never armed at the same time, so a
 * single touch resolves to exactly one of them.
 *
 * ## Where each gesture yields
 *
 * The opening gesture listens on `document` across the whole route and arms
 * over a wide band of the viewport, so it has to yield to anything more
 * specific that a left-edge swipe could mean: a back-swipe owner (a pushed page
 * under this layout) and a revealed swipe-action row anywhere on the route,
 * both counted by the shared arbiter store.
 *
 * The closing gesture arms on the panel's own touch handlers, so it yields at
 * the target instead: `useSwipeCloseDrawer` stands down over a row that owns
 * its own horizontal drag. Route-wide arbitration would be wrong here, because
 * a row revealed on the page *behind* the drawer says nothing about a touch
 * landing on the drawer.
 *
 * ## Presence
 *
 * `present` outlives `open`. Unmounting the panel the moment the drawer closes
 * takes the closing transform off screen with it, so the panel vanishes instead
 * of sliding out. It stays mounted until the slide finishes, resolved by
 * `transitionend` with a timeout fallback for the case where no transition runs
 * at all (reduced motion, a zero-duration override, a backgrounded tab).
 */
export function useChatLayoutDrawerGestures({
  panelRef,
  isMobile,
  open,
  onOpen,
  onClose,
}: UseChatLayoutDrawerGesturesArgs): UseChatLayoutDrawerGesturesResult {
  const visible = isMobile && open;

  // True while a left-edge swipe is dragging the panel in from off-screen but
  // has not yet committed open; keeps it mounted so its transform can track the
  // finger before `open` flips.
  const [dragging, setDragging] = useState(false);

  // Mounted-ness, which lags `visible` on the way out so the closing slide has
  // something to run on. Raised during render, because a commit that mounts the
  // panel one render late would start it at its resting transform and skip the
  // opening slide entirely.
  const [rendered, setRendered] = useState(visible);
  if (visible && !rendered) {
    setRendered(true);
  }

  const backSwipeOwnerCount = useEdgeSwipeArbiterStore.use.backOwnerCount();
  const openRowCount = useEdgeSwipeArbiterStore.use.openRowCount();

  useEdgeSwipeDrawer({
    panelRef,
    enabled:
      isMobile && !open && backSwipeOwnerCount === 0 && openRowCount === 0,
    onDragStart: () => setDragging(true),
    onOpen: () => {
      onOpen();
      setDragging(false);
    },
    onSettle: () => setDragging(false),
  });

  const closeSwipe = useSwipeCloseDrawer({ enabled: visible, onClose });

  useEffect(() => {
    if (visible || !rendered) {
      return;
    }
    const el = panelRef.current;
    if (!el) {
      setRendered(false);
      return;
    }
    let settled = false;
    const finish = (event?: Event) => {
      // Descendants of the panel run transitions of their own, and those
      // bubble. Only the panel's own slide ends this.
      if (settled || (event && event.target !== el)) {
        return;
      }
      settled = true;
      el.removeEventListener("transitionend", finish);
      setRendered(false);
    };
    el.addEventListener("transitionend", finish);
    const fallback = setTimeout(
      finish,
      EDGE_SWIPE_SLIDE_MS + EDGE_SWIPE_FALLBACK_SLACK_MS,
    );
    return () => {
      settled = true;
      el.removeEventListener("transitionend", finish);
      clearTimeout(fallback);
    };
  }, [visible, rendered, panelRef]);

  useEffect(() => {
    if (!isMobile) {
      setDragging(false);
    }
  }, [isMobile]);

  return {
    present: rendered || dragging,
    exiting: rendered && !visible,
    dragOffset: closeSwipe.dragOffset,
    isDragging: closeSwipe.isDragging,
    onTouchStart: closeSwipe.onTouchStart,
    onTouchMove: closeSwipe.onTouchMove,
    onTouchEnd: closeSwipe.onTouchEnd,
    onTouchCancel: closeSwipe.onTouchCancel,
  };
}
