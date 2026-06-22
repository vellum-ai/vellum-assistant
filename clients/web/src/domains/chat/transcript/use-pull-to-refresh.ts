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

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

import {
  PULL_ELIGIBLE_BOTTOM_DISTANCE_PX,
  PULL_REFRESH_VISUAL_PX,
  PULL_THRESHOLD_PX,
  canStartPull,
  classifyPull,
  computePullExtent,
  distanceFromBottom,
  shouldFireThresholdHaptic,
} from "@/domains/chat/transcript/pull-to-refresh-utils";
import { haptic } from "@/utils/haptics";

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
  useLayoutEffect(() => {
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
