import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

import { useEdgeSwipe } from "@/hooks/use-edge-swipe";

/** Duration (ms) of the open / snap-closed animation the finger hands off to. */
export const DRAWER_SLIDE_MS = 200;

/** Slack (ms) added to the animation duration for the safety-fallback timer. */
const ANIMATION_FALLBACK_SLACK_MS = 50;

/** Clear the inline styles this hook owns, returning ownership to React. */
function resetTransientStyles(el: HTMLElement): void {
  el.style.transition = "";
  el.style.transform = "";
  el.style.willChange = "";
}

export interface UseEdgeSwipeDrawerArgs {
  /**
   * Ref to the sliding panel element. Its `translateX` is dragged with the
   * finger; at rest React owns the transform (`translateX(0)` open,
   * `translateX(-100%)` closed).
   */
  panelRef: RefObject<HTMLElement | null>;
  /** Whether the gesture is enabled (typically mobile, closed, no back-swipe owner). */
  enabled: boolean;
  /** Fired when the gesture confirms, so the caller can mount the panel to drag. */
  onDragStart: () => void;
  /** Fired when the swipe is released past the commit threshold — open the drawer. */
  onOpen: () => void;
  /** Fired once a non-committed gesture has snapped closed — the caller can unmount. */
  onSettle: () => void;
}

/**
 * Left-edge swipe-to-open-menu for the mobile chat shell — the opening
 * counterpart to `useEdgeSwipeBack`, sharing the same `useEdgeSwipe`
 * detection engine.
 *
 * The panel tracks the finger 1:1 from off-screen-left (its revealed width
 * equals the horizontal drag distance); releasing past the commit threshold
 * hands off to a short slide-to-open animation, and releasing short snaps it
 * back closed. Because detection lives in the shared engine and this hook
 * suppresses itself whenever a back-swipe owner is active (via the caller's
 * `enabled`), a single left-edge swipe never both opens the menu and
 * navigates back.
 *
 * Like `useEdgeSwipeBack`, the drag transform is applied imperatively (React
 * state can't keep up with a 60fps drag); React owns the resting transform,
 * and this hook clears its inline styles once each animation settles.
 */
export function useEdgeSwipeDrawer({
  panelRef,
  enabled,
  onDragStart,
  onOpen,
  onSettle,
}: UseEdgeSwipeDrawerArgs): void {
  const callbacksRef = useRef({ onDragStart, onOpen, onSettle });
  useLayoutEffect(() => {
    callbacksRef.current = { onDragStart, onOpen, onSettle };
  });

  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    const timers = timersRef.current;
    return () => {
      cancelledRef.current = true;
      for (const id of timers) {clearTimeout(id);}
      timers.clear();
      const el = panelRef.current;
      if (el) {resetTransientStyles(el);}
    };
  }, [panelRef]);

  const scheduleTimeout = (fn: () => void, ms: number) => {
    const id = setTimeout(() => {
      timersRef.current.delete(id);
      if (!cancelledRef.current) {fn();}
    }, ms);
    timersRef.current.add(id);
  };

  useEdgeSwipe({
    enabled,
    onConfirm: () => {
      callbacksRef.current.onDragStart();
    },
    onMove: (dx) => {
      const el = panelRef.current;
      if (!el) {return;}
      // Reveal width equals drag distance: the panel's right edge tracks the
      // finger from off-screen-left toward fully open at translateX(0).
      const offset = Math.min(0, dx - window.innerWidth);
      el.style.transition = "none";
      el.style.willChange = "transform";
      el.style.transform = `translateX(${offset}px)`;
    },
    onCommit: () => {
      const el = panelRef.current;
      if (el) {
        // Slide the remaining distance to fully open, then hand the resting
        // transform back to React (which renders `translateX(0)` while open).
        el.style.transition = `transform ${DRAWER_SLIDE_MS}ms ease-out`;
        el.style.transform = "translateX(0)";
        const finish = () => {
          el.removeEventListener("transitionend", finish);
          if (!cancelledRef.current) {resetTransientStyles(el);}
        };
        el.addEventListener("transitionend", finish, { once: true });
        scheduleTimeout(finish, DRAWER_SLIDE_MS + ANIMATION_FALLBACK_SLACK_MS);
      }
      callbacksRef.current.onOpen();
    },
    onCancel: (animate) => {
      const el = panelRef.current;
      if (!animate || !el) {
        callbacksRef.current.onSettle();
        return;
      }
      // Snap the peeked panel back off-screen, then let the caller unmount it.
      el.style.transition = `transform ${DRAWER_SLIDE_MS}ms ease-out`;
      el.style.transform = "translateX(-100%)";
      let done = false;
      const finish = () => {
        if (done || cancelledRef.current) {return;}
        done = true;
        el.removeEventListener("transitionend", finish);
        resetTransientStyles(el);
        callbacksRef.current.onSettle();
      };
      el.addEventListener("transitionend", finish, { once: true });
      scheduleTimeout(finish, DRAWER_SLIDE_MS + ANIMATION_FALLBACK_SLACK_MS);
    },
  });
}
