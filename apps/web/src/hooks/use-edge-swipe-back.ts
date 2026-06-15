import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

import { haptic } from "@/utils/haptics";
import { isPointerCoarse } from "@/utils/pointer";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Horizontal zone from the left edge (px) where a touch is eligible. */
const EDGE_ZONE_PX = 20;

/** Minimum horizontal travel (px) to commit the swipe. */
const COMMIT_THRESHOLD_PX = 100;

/**
 * Maximum ratio of viewport width that serves as an alternative commit
 * threshold — whichever of `COMMIT_THRESHOLD_PX` and this fraction is
 * smaller wins.
 */
const COMMIT_THRESHOLD_VW = 0.3;

/**
 * If vertical travel exceeds this ratio of horizontal travel, the
 * gesture is cancelled (user is scrolling, not swiping).
 */
const VERTICAL_ESCAPE_RATIO = 0.7;

/** Damping applied to drag distance past the commit threshold. */
const OVERDRAG_DAMPING = 0.3;

/** Duration (ms) for the cancel/snap-back animation. */
const CANCEL_ANIMATION_MS = 200;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseEdgeSwipeBackArgs {
  /** Ref to the element that receives the translateX visual transform. */
  containerRef: RefObject<HTMLElement | null>;
  /** Callback fired when the swipe is committed. */
  onBack: () => void;
  /** Whether the gesture is enabled. */
  enabled: boolean;
}

interface DragState {
  touchId: number;
  startX: number;
  startY: number;
  /** Whether the gesture has been confirmed as horizontal (past deadzone). */
  confirmed: boolean;
  hasFiredHaptic: boolean;
}

/**
 * Detects left-edge swipe gestures and triggers a back-navigation callback.
 *
 * Touch listeners are attached to `document` so the full viewport edge is
 * reachable regardless of CSS padding on ancestor elements. The container
 * ref is used only for applying the translateX visual transform.
 */
export function useEdgeSwipeBack({
  containerRef,
  onBack,
  enabled,
}: UseEdgeSwipeBackArgs): void {
  const dragRef = useRef<DragState | null>(null);
  const onBackRef = useRef(onBack);
  useLayoutEffect(() => {
    onBackRef.current = onBack;
  }, [onBack]);

  useEffect(() => {
    if (!enabled) return;
    if (!isPointerCoarse()) return;

    const el = containerRef.current;
    if (!el) return;

    const commitThreshold = () =>
      Math.min(COMMIT_THRESHOLD_PX, window.innerWidth * COMMIT_THRESHOLD_VW);

    const applyOffset = (px: number) => {
      el.style.transform = px === 0 ? "" : `translateX(${px}px)`;
    };

    const reset = (animate: boolean) => {
      dragRef.current = null;
      if (animate) {
        el.style.transition = `transform ${CANCEL_ANIMATION_MS}ms ease-out`;
        applyOffset(0);
        const onEnd = () => {
          el.style.transition = "";
          el.style.transform = "";
          el.removeEventListener("transitionend", onEnd);
        };
        el.addEventListener("transitionend", onEnd, { once: true });
        // Safety fallback if transitionend doesn't fire.
        setTimeout(() => {
          el.style.transition = "";
          el.style.transform = "";
        }, CANCEL_ANIMATION_MS + 50);
      } else {
        el.style.transition = "";
        el.style.transform = "";
      }
    };

    // Listen on document so touches at the viewport edge are captured even
    // when the container is inset by parent padding.
    const handleTouchStart = (event: TouchEvent) => {
      if (dragRef.current) return;
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (!touch) return;

      if (touch.clientX > EDGE_ZONE_PX) return;

      dragRef.current = {
        touchId: touch.identifier,
        startX: touch.clientX,
        startY: touch.clientY,
        confirmed: false,
        hasFiredHaptic: false,
      };
    };

    const handleTouchMove = (event: TouchEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (event.touches.length > 1) {
        reset(false);
        return;
      }

      let touch: Touch | null = null;
      for (let i = 0; i < event.touches.length; i += 1) {
        const t = event.touches[i];
        if (t && t.identifier === drag.touchId) {
          touch = t;
          break;
        }
      }
      if (!touch) return;

      const dx = touch.clientX - drag.startX;
      const dy = touch.clientY - drag.startY;

      // Deadzone: require at least 10px horizontal before deciding direction.
      if (!drag.confirmed) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        if (Math.abs(dy) > Math.abs(dx) * VERTICAL_ESCAPE_RATIO) {
          reset(false);
          return;
        }
        if (dx <= 0) {
          reset(false);
          return;
        }
        drag.confirmed = true;
        el.style.transition = "none";
        el.style.willChange = "transform";
      }

      // Cancel if vertical travel becomes excessive during mid-gesture.
      if (Math.abs(dy) > Math.abs(dx) * VERTICAL_ESCAPE_RATIO && dx < commitThreshold()) {
        reset(true);
        return;
      }

      // Compute visual offset with damping past threshold.
      const threshold = commitThreshold();
      let visualOffset: number;
      if (dx <= threshold) {
        visualOffset = dx;
      } else {
        visualOffset = threshold + (dx - threshold) * OVERDRAG_DAMPING;
      }

      // Haptic at threshold crossing.
      if (dx >= threshold && !drag.hasFiredHaptic) {
        drag.hasFiredHaptic = true;
        void haptic.light();
      }

      applyOffset(visualOffset);
    };

    const handleTouchEnd = (event: TouchEvent) => {
      const drag = dragRef.current;
      if (!drag) return;

      let finalDx = 0;
      for (let i = 0; i < event.changedTouches.length; i += 1) {
        const t = event.changedTouches[i];
        if (t && t.identifier === drag.touchId) {
          finalDx = t.clientX - drag.startX;
          break;
        }
      }

      const committed = drag.confirmed && finalDx >= commitThreshold();

      if (committed) {
        // Navigate. Reset styles immediately — the page transition
        // handles the visual change.
        reset(false);
        onBackRef.current();
      } else if (drag.confirmed) {
        // Animate back to resting position.
        reset(true);
      } else {
        // Gesture never confirmed — clean up silently.
        reset(false);
      }
    };

    const handleTouchCancel = () => {
      if (dragRef.current?.confirmed) {
        reset(true);
      } else {
        reset(false);
      }
    };

    document.addEventListener("touchstart", handleTouchStart, { passive: true });
    document.addEventListener("touchmove", handleTouchMove, { passive: true });
    document.addEventListener("touchend", handleTouchEnd, { passive: true });
    document.addEventListener("touchcancel", handleTouchCancel, { passive: true });

    return () => {
      document.removeEventListener("touchstart", handleTouchStart);
      document.removeEventListener("touchmove", handleTouchMove);
      document.removeEventListener("touchend", handleTouchEnd);
      document.removeEventListener("touchcancel", handleTouchCancel);
      el.style.transition = "";
      el.style.transform = "";
      el.style.willChange = "";
    };
  }, [enabled, containerRef]);
}
