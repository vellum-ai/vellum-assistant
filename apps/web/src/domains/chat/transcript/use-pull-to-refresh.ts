// Pull-to-refresh gesture hook for the chronological-order chat
// transcript (flex-col, latest at the visual bottom).
//
// Eligibility window: the user must be at the visual bottom of the
// transcript (latest message). In flex-col, that means
// `scrollHeight − clientHeight − scrollTop` is small. We use a tighter
// eligibility threshold than the scroll coordinator's
// `PINNED_THRESHOLD_PX` because the gesture is disruptive and should
// only fire when the user is unambiguously looking at the latest
// message.
//
// Drag direction: at the visual bottom of a flex-col chat the
// iOS-native pull-to-refresh gesture is a DOWNWARD finger motion —
// the same direction Mail/Messages use to refresh the latest. The
// latest message sits anchored just above the composer; pulling the
// finger down opens rubber-band space below the latest bubble where
// the spinner reveals itself. An upward finger motion at the visual
// bottom is the user starting to scroll back through history, NOT a
// refresh request, and is treated as ineligible.
//
// Concretely: clientY INCREASES when the finger moves down the screen,
// so we compute pull extent as (currentY − startY). Positive extent
// means the finger has traveled downward — i.e., the user is pulling.

import { useEffect, useRef, useState, type RefObject } from "react";

import { haptic } from "@/utils/haptics";

/** Drag distance (in raw pixels) at which the refresh commits on
 *  release. Matches `PINNED_THRESHOLD_PX` from the scroll coordinator
 *  for visual consistency. */
export const PULL_THRESHOLD_PX = 64;

/** Distance from the visual bottom (in px) at or below which the
 *  pull-to-refresh gesture is eligible to start. Tighter than
 *  `PINNED_THRESHOLD_PX` so the gesture only fires when the user is
 *  unambiguously at the latest message. */
export const PULL_ELIGIBLE_BOTTOM_DISTANCE_PX = 16;

/** Visual height (in px) the spinner locks at while the refresh is
 *  in flight. */
export const PULL_REFRESH_VISUAL_PX = 48;

export interface PullClassification {
  phase: "ineligible" | "pulling";
  /** 0..1, clamped. */
  progress: number;
  atThreshold: boolean;
}

/** Compute the pull extent (in px) given the touch's starting and
 *  current Y coordinates. At the visual bottom of a flex-col
 *  transcript, the pull-to-refresh gesture is a DOWNWARD finger motion
 *  (clientY increases). Positive extent means the user is pulling
 *  for refresh. Exposed for direct unit testing — this is the single
 *  source of truth for gesture direction. */
export function computePullExtent(args: {
  startY: number;
  currentY: number;
}): number {
  return args.currentY - args.startY;
}

/** Distance (in px) from the visual bottom of the transcript. In
 *  flex-col layout this is `max(0, scrollHeight − clientHeight −
 *  scrollTop)`. Clamped at 0 so iOS rubber-band (scrollTop briefly
 *  above max) doesn't report a negative distance. */
export function distanceFromBottom(args: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): number {
  const max = Math.max(0, args.scrollHeight - args.clientHeight);
  return Math.max(0, max - args.scrollTop);
}

/** Pure classification of the current touch state during a drag.
 *  `dragDistance` is the pull extent — positive means the finger
 *  has moved downward from its start (a real pull); non-positive
 *  means the finger is still or has moved upward (no pull).
 *  Exposed for direct unit testing. */
export function classifyPull(args: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  dragDistance: number;
}): PullClassification {
  const dfb = distanceFromBottom(args);
  const eligible = dfb <= PULL_ELIGIBLE_BOTTOM_DISTANCE_PX;
  if (!eligible || args.dragDistance <= 0) {
    return { phase: "ineligible", progress: 0, atThreshold: false };
  }
  const progress = Math.min(1, args.dragDistance / PULL_THRESHOLD_PX);
  return {
    phase: "pulling",
    progress,
    atThreshold: args.dragDistance >= PULL_THRESHOLD_PX,
  };
}

/** Decide whether the threshold-cross haptic should fire on this
 *  classification step, given the per-drag "has fired" flag. Pure —
 *  exposed for unit testing. */
export function shouldFireThresholdHaptic(args: {
  atThreshold: boolean;
  hasFiredThisDrag: boolean;
}): boolean {
  return args.atThreshold && !args.hasFiredThisDrag;
}

/** Decide whether a new touch should start tracking a pull. Pure —
 *  exposed for unit testing. The refresh-in-flight guard lives here. */
export function canStartPull(args: {
  isRefreshing: boolean;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): boolean {
  if (args.isRefreshing) return false;
  return distanceFromBottom(args) <= PULL_ELIGIBLE_BOTTOM_DISTANCE_PX;
}

/** Map raw drag distance to the visual pull height. Past the threshold
 *  we apply gentle damping so the spinner doesn't grow without bound
 *  if the user keeps dragging. */
function visualPullHeight(dragDistance: number): number {
  if (dragDistance <= 0) return 0;
  if (dragDistance <= PULL_THRESHOLD_PX) return dragDistance;
  return PULL_THRESHOLD_PX + (dragDistance - PULL_THRESHOLD_PX) * 0.4;
}

export interface UsePullToRefreshArgs {
  scrollRef: RefObject<HTMLDivElement | null>;
  onRefresh: () => Promise<void>;
  enabled: boolean;
}

export type PullPhase = "idle" | "dragging" | "refreshing";

export interface UsePullToRefreshReturn {
  pullDistance: number;
  isAtThreshold: boolean;
  isRefreshing: boolean;
  phase: PullPhase;
}

interface DragState {
  primaryTouchId: number;
  startY: number;
  hasFiredThresholdHaptic: boolean;
}

export function usePullToRefresh({
  scrollRef,
  onRefresh,
  enabled,
}: UsePullToRefreshArgs): UsePullToRefreshReturn {
  const [pullDistance, setPullDistance] = useState(0);
  const [isAtThreshold, setIsAtThreshold] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const dragRef = useRef<DragState | null>(null);
  const isRefreshingRef = useRef(false);
  const onRefreshRef = useRef(onRefresh);
  useEffect(() => {
    isRefreshingRef.current = isRefreshing;
    onRefreshRef.current = onRefresh;
  }, [isRefreshing, onRefresh]);

  const phase: PullPhase = isRefreshing
    ? "refreshing"
    : isDragging
      ? "dragging"
      : "idle";

  useEffect(() => {
    if (!enabled) return;
    const el = scrollRef.current;
    if (!el) return;

    // The Transcript scroll container ships with `overscroll-none` as a
    // baseline class. We *also* set the inline style during an active pull
    // so the suppression survives any future inline-style writes (e.g. from
    // a virtualizer or sibling effect) — inline trumps class. Using "none"
    // (not "contain") is critical: "contain" only blocks scroll chaining
    // while still letting the element itself rubber-band, which is exactly
    // the iOS behavior that pushes scrollTop past the 16-px eligibility
    // window mid-drag and breaks the gesture on scrollable transcripts.
    let originalOverscrollBehavior: string | null = null;

    const suppressOverscroll = () => {
      if (originalOverscrollBehavior === null) {
        originalOverscrollBehavior = el.style.overscrollBehavior;
        el.style.overscrollBehavior = "none";
      }
    };

    const restoreOverscroll = () => {
      if (originalOverscrollBehavior !== null) {
        el.style.overscrollBehavior = originalOverscrollBehavior;
        originalOverscrollBehavior = null;
      }
    };

    const resetVisuals = () => {
      dragRef.current = null;
      setPullDistance(0);
      setIsAtThreshold(false);
      setIsDragging(false);
      restoreOverscroll();
    };

    const findPrimaryTouch = (event: TouchEvent, id: number): Touch | null => {
      for (let i = 0; i < event.touches.length; i += 1) {
        const t = event.touches[i];
        if (t && t.identifier === id) return t;
      }
      return null;
    };

    const handleTouchStart = (event: TouchEvent) => {
      if (!canStartPull({
        isRefreshing: isRefreshingRef.current,
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      })) {
        return;
      }
      // Only single-finger interactions are pull candidates. Multi-touch
      // (pinch / two-finger drag) cancels the gesture.
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (!touch) return;
      dragRef.current = {
        primaryTouchId: touch.identifier,
        startY: touch.clientY,
        hasFiredThresholdHaptic: false,
      };
      setIsDragging(true);
    };

    const handleTouchMove = (event: TouchEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (isRefreshingRef.current) return;
      // Multi-touch cancels mid-drag.
      if (event.touches.length > 1) {
        resetVisuals();
        return;
      }
      const touch = findPrimaryTouch(event, drag.primaryTouchId);
      if (!touch) return;
      const pullExtent = computePullExtent({
        startY: drag.startY,
        currentY: touch.clientY,
      });
      const cls = classifyPull({
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        dragDistance: pullExtent,
      });
      if (cls.phase === "ineligible") {
        // The user scrolled off the bottom (e.g. momentum carried them
        // past the eligibility window) or is moving the finger upward
        // (the wrong direction for PTR-at-bottom). Only treat as a real
        // cancel if the visual already showed a pull — otherwise let
        // touchend decide.
        const dfb = distanceFromBottom({
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
        });
        if (pullExtent < 0 || dfb > PULL_ELIGIBLE_BOTTOM_DISTANCE_PX) {
          resetVisuals();
        }
        return;
      }
      suppressOverscroll();
      if (
        shouldFireThresholdHaptic({
          atThreshold: cls.atThreshold,
          hasFiredThisDrag: drag.hasFiredThresholdHaptic,
        })
      ) {
        drag.hasFiredThresholdHaptic = true;
        void haptic.light();
      }
      setPullDistance(visualPullHeight(pullExtent));
      setIsAtThreshold(cls.atThreshold);
      // Spinner is the last DOM child of the scroll content (flex-col),
      // so its growing height extends scrollHeight *below* the current
      // viewport. Without an explicit follow-scroll the user never sees
      // the spinner during the pull — in flex-col-reverse this was free
      // because the visual bottom was anchored to scrollTop=0. Mirror
      // that anchoring here by pinning to the new bottom on every
      // touchmove that advances the pull. Cheap (no layout thrash —
      // scrollTo doesn't force layout when only scrollTop changes).
      el.scrollTop = el.scrollHeight - el.clientHeight;
    };

    const handleTouchEnd = (event: TouchEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (isRefreshingRef.current) return;

      let finalPullExtent = 0;
      for (let i = 0; i < event.changedTouches.length; i += 1) {
        const t = event.changedTouches[i];
        if (t && t.identifier === drag.primaryTouchId) {
          finalPullExtent = computePullExtent({
            startY: drag.startY,
            currentY: t.clientY,
          });
          break;
        }
      }
      const dfb = distanceFromBottom({
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      });
      const committed =
        dfb <= PULL_ELIGIBLE_BOTTOM_DISTANCE_PX &&
        finalPullExtent >= PULL_THRESHOLD_PX;

      if (!committed) {
        resetVisuals();
        return;
      }

      // Commit. Lock spinner at PULL_REFRESH_VISUAL_PX and start the
      // refresh. Clear the drag ref so any stray events (synthetic
      // touchend etc.) don't try to re-commit.
      dragRef.current = null;
      setPullDistance(PULL_REFRESH_VISUAL_PX);
      setIsAtThreshold(true);
      setIsDragging(false);
      setIsRefreshing(true);
      void (async () => {
        try {
          await onRefreshRef.current();
        } finally {
          setIsRefreshing(false);
          setPullDistance(0);
          setIsAtThreshold(false);
          restoreOverscroll();
        }
      })();
    };

    const handleTouchCancel = () => {
      // Don't disturb in-flight refresh state.
      if (isRefreshingRef.current) return;
      resetVisuals();
    };

    el.addEventListener("touchstart", handleTouchStart, { passive: true });
    el.addEventListener("touchmove", handleTouchMove, { passive: true });
    el.addEventListener("touchend", handleTouchEnd, { passive: true });
    el.addEventListener("touchcancel", handleTouchCancel, { passive: true });
    el.addEventListener("pointercancel", handleTouchCancel, { passive: true });

    return () => {
      el.removeEventListener("touchstart", handleTouchStart);
      el.removeEventListener("touchmove", handleTouchMove);
      el.removeEventListener("touchend", handleTouchEnd);
      el.removeEventListener("touchcancel", handleTouchCancel);
      el.removeEventListener("pointercancel", handleTouchCancel);
      restoreOverscroll();
    };
  }, [enabled, scrollRef]);

  return { pullDistance, isAtThreshold, isRefreshing, phase };
}
