import { useCallback, useRef, type TouchEvent as ReactTouchEvent } from "react";

import { haptic } from "@/utils/haptics";
import { isInteractiveTarget } from "@/utils/interactive-target";
import { isPointerCoarse } from "@/utils/pointer";

const DEFAULT_THRESHOLD_MS = 500;
const MOVE_TOLERANCE_PX = 10;

export interface UseLongPressHandlers {
  onTouchStart: (e: ReactTouchEvent) => void;
  onTouchMove: (e: ReactTouchEvent) => void;
  onTouchEnd: () => void;
  onTouchCancel: () => void;
}

export interface UseLongPressOptions {
  /**
   * Optional predicate evaluated against the touch target at touchstart. When
   * it returns `true`, the long-press is not armed for that touch. Use it to
   * suppress the action sheet where another gesture owns the long-press — e.g.
   * assistant-message text, where a long-press starts a quote-reply text
   * selection and the two must not compete. Evaluated at touchstart (not at
   * the threshold) so the timer is never armed, avoiding the race where the
   * text selection settles only after the threshold fires.
   */
  shouldSkip?: (target: Element | null) => boolean;
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
  options: UseLongPressOptions = {},
): UseLongPressHandlers {
  const { shouldSkip } = options;
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
      const target = e.target as Element | null;
      // Skip if the touch landed on an interactive element (inline link,
      // button, form control, [role="button"], etc.) — the user's intent
      // is to interact with that control, not to open the long-press
      // action sheet. Mirrors the `isInteractiveClickTarget` guard in
      // `handleBubbleClick` (transcript-message-body.tsx).
      if (isInteractiveTarget(target)) return;
      // Skip where another gesture owns the long-press for this target (e.g.
      // assistant-message text, which long-presses into a quote-reply
      // selection). Evaluated here at touchstart so the timer never arms —
      // deciding at the threshold would race the text selection, which on iOS
      // often settles only after the threshold fires.
      if (shouldSkip?.(target)) return;
      startPosRef.current = { x: touch.clientX, y: touch.clientY };
      clearTimer();
      timerRef.current = setTimeout(() => {
        // Skip if the user has selected text — the browser's text
        // selection long-press is the user's intent, not the action
        // sheet. Without this, selecting text to copy would also
        // pop the BottomSheet.
        const selection = window.getSelection();
        if (selection && selection.toString().length > 0) {
          clearTimer();
          return;
        }
        haptic.light();
        callback();
      }, threshold);
    },
    [callback, threshold, clearTimer, shouldSkip],
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
