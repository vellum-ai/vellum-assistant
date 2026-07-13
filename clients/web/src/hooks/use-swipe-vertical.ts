import { useCallback } from "react";
import type { TouchEvent as ReactTouchEvent } from "react";

import { useSwipeEngine } from "@/hooks/use-swipe-engine";
import { haptic } from "@/utils/haptics";

/**
 * Minimum vertical travel (px) to commit a swipe. Below this the drag springs
 * back and no callback fires. Tuned to feel intentional without demanding a
 * full-height drag, matching the modest commit distances of native
 * swipe-to-dismiss sheets.
 */
const DEFAULT_COMMIT_THRESHOLD_PX = 80;

interface UseSwipeVerticalArgs {
  /** Whether swiping is possible (e.g. overlay is mounted and interactive). */
  enabled: boolean;
  /** Fired when a downward swipe passes the commit threshold. */
  onSwipeDown?: () => void;
  /** Fired when an upward swipe passes the commit threshold. */
  onSwipeUp?: () => void;
  /** Minimum vertical travel (px) to commit. Defaults to 80. */
  commitThresholdPx?: number;
}

interface UseSwipeVerticalResult {
  /** Live vertical drag offset (px), positive = down. 0 at rest. */
  dragOffset: number;
  /** True while a vertical drag is in progress (disable transitions). */
  isDragging: boolean;
  onTouchStart: (e: ReactTouchEvent) => void;
  onTouchMove: (e: ReactTouchEvent) => void;
  onTouchEnd: (e: ReactTouchEvent) => void;
  onTouchCancel: () => void;
}

/**
 * Vertical swipe gesture detector for touch devices. On release it commits to a
 * downward or upward swipe if travel passed the commit threshold, else springs
 * back. Horizontal-dominant gestures are ignored so horizontal pans and the
 * browser's own scrolling are never hijacked.
 *
 * Complements on-screen buttons — this is the touch-first path (primarily iOS).
 * Only active on coarse-pointer (touch) devices; on desktop the handlers are
 * inert no-ops.
 *
 * Thin wrapper over {@link useSwipeEngine} (the shared single-touch swipe state
 * machine): maps the signed commit delta on release to down (positive) / up
 * (negative) callbacks and supplies haptics, exactly as `use-swipe-horizontal`
 * maps it to right / left.
 */
export function useSwipeVertical({
  enabled,
  onSwipeDown,
  onSwipeUp,
  commitThresholdPx = DEFAULT_COMMIT_THRESHOLD_PX,
}: UseSwipeVerticalArgs): UseSwipeVerticalResult {
  const onCommit = useCallback(
    (delta: number) => {
      if (delta >= commitThresholdPx) {
        haptic.light();
        onSwipeDown?.();
      } else if (delta <= -commitThresholdPx) {
        haptic.light();
        onSwipeUp?.();
      }
    },
    [commitThresholdPx, onSwipeDown, onSwipeUp],
  );

  return useSwipeEngine({
    enabled,
    axis: "vertical",
    commitThresholdPx,
    touchOnly: true,
    onCommit,
  });
}
