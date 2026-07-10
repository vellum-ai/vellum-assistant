import { useCallback, useRef, type TouchEvent as ReactTouchEvent } from "react";

import { haptic } from "@/utils/haptics";
import { isPointerCoarse } from "@/utils/pointer";

const DEFAULT_THRESHOLD_MS = 500;
const MOVE_TOLERANCE_PX = 10;

export interface UseLongPressHandlers {
  onTouchStart: (e: ReactTouchEvent) => void;
  onTouchMove: (e: ReactTouchEvent) => void;
  onTouchEnd: () => void;
  onTouchCancel: () => void;
}

/**
 * Long-press gesture hook for touch devices. Returns touch event handlers
 * that fire `callback` after the user holds for `threshold` ms without
 * moving more than `MOVE_TOLERANCE_PX` pixels. Cancels on touch end, touch
 * cancel, or excessive movement (scrolling). Fires `haptic.light()` on
 * activation so the user feels the long-press register.
 *
 * Only activates on coarse-pointer (touch) devices — on desktop the
 * handlers are inert stubs so callers can spread them unconditionally
 * without conditional rendering.
 */
export function useLongPress(
  callback: () => void,
  threshold: number = DEFAULT_THRESHOLD_MS,
): UseLongPressHandlers {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startPosRef = useRef<{ x: number; y: number } | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const onTouchStart = useCallback(
    (e: ReactTouchEvent) => {
      if (!isPointerCoarse()) return;
      const touch = e.touches[0];
      if (!touch) return;
      startPosRef.current = { x: touch.clientX, y: touch.clientY };
      clearTimer();
      timerRef.current = setTimeout(() => {
        haptic.light();
        callback();
      }, threshold);
    },
    [callback, threshold, clearTimer],
  );

  const onTouchMove = useCallback(
    (e: ReactTouchEvent) => {
      if (!startPosRef.current) return;
      const touch = e.touches[0];
      if (!touch) return;
      const dx = touch.clientX - startPosRef.current.x;
      const dy = touch.clientY - startPosRef.current.y;
      if (Math.hypot(dx, dy) > MOVE_TOLERANCE_PX) {
        clearTimer();
      }
    },
    [clearTimer],
  );

  const onTouchEnd = useCallback(() => {
    clearTimer();
    startPosRef.current = null;
  }, [clearTimer]);

  const onTouchCancel = useCallback(() => {
    clearTimer();
    startPosRef.current = null;
  }, [clearTimer]);

  return { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel };
}
