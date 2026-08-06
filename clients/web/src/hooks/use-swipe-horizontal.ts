import { useCallback } from "react";
import type { TouchEvent as ReactTouchEvent } from "react";

import { useSwipeEngine } from "@/hooks/use-swipe-engine";
import { haptic } from "@/utils/haptics";

/**
 * Minimum horizontal travel (px) to commit a swipe. Below this the drag
 * springs back and no callback fires.
 */
const DEFAULT_COMMIT_THRESHOLD_PX = 80;

interface UseSwipeHorizontalArgs {
  /** Whether swiping is possible (e.g. drawer is open and interactive). */
  enabled: boolean;
  /** Fired when a leftward swipe passes the commit threshold. */
  onSwipeLeft?: () => void;
  /** Fired when a rightward swipe passes the commit threshold. */
  onSwipeRight?: () => void;
  /** Minimum horizontal travel (px) to commit. Defaults to 80. */
  commitThresholdPx?: number;
}

interface UseSwipeHorizontalResult {
  /** Live horizontal drag offset (px), positive = right. 0 at rest. */
  dragOffset: number;
  /** True while a horizontal drag is in progress (disable transitions). */
  isDragging: boolean;
  onTouchStart: (e: ReactTouchEvent) => void;
  onTouchMove: (e: ReactTouchEvent) => void;
  onTouchEnd: (e: ReactTouchEvent) => void;
  onTouchCancel: () => void;
}

/**
 * Horizontal swipe gesture detector for touch devices. Tracks a single touch,
 * follows the finger with a live `dragOffset`, and on release commits to a
 * leftward or rightward swipe if travel passed the commit threshold, else
 * springs back. Vertical-dominant gestures are ignored so vertical scrolls and
 * the browser's own scrolling are never hijacked.
 *
 * Thin-wraps the shared {@link useSwipeEngine} state machine, mapping its signed
 * commit delta to left/right callbacks and supplying haptics. Complements
 * on-screen buttons — this is the touch-first path (primarily iOS). Only active
 * on coarse-pointer (touch) devices; on desktop the handlers are inert no-ops.
 */
export function useSwipeHorizontal({
  enabled,
  onSwipeLeft,
  onSwipeRight,
  commitThresholdPx = DEFAULT_COMMIT_THRESHOLD_PX,
}: UseSwipeHorizontalArgs): UseSwipeHorizontalResult {
  const onCommit = useCallback(
    (delta: number) => {
      if (delta <= -commitThresholdPx) {
        haptic.light();
        onSwipeLeft?.();
      } else if (delta >= commitThresholdPx) {
        haptic.light();
        onSwipeRight?.();
      }
    },
    [commitThresholdPx, onSwipeLeft, onSwipeRight],
  );

  return useSwipeEngine({
    enabled,
    axis: "horizontal",
    commitThresholdPx,
    touchOnly: true,
    onCommit,
  });
}
