/**
 * Long-press → action-sheet plumbing, shared by every surface that swaps a
 * desktop right-click menu for a touch bottom sheet (sidebar conversation
 * rows, sidebar section headers).
 *
 * Wraps {@link useLongPress} with the three invariants that surface needs:
 *
 * 1. **The gesture arms on interactive targets.** These surfaces are
 *    themselves buttons (or `role="button"`), so the default
 *    interactive-target skip would suppress the gesture entirely. Callers
 *    pass `shouldSkip` to exclude nested real controls instead.
 * 2. **The release emits no compatibility mouse events.** A touch that fired
 *    the gesture would otherwise be followed by `mousedown`, `mouseup` and
 *    `click` retargeted outside the row, which the sheet's dismissable layer
 *    reads as a click-outside and closes the sheet the gesture just opened.
 *    Cancelling the `touchend` suppresses that whole sequence at its source.
 * 3. **A compatibility click is swallowed if one arrives anyway.**
 *    `wrapperProps` carries a capture-phase handler that eats one click per
 *    fired gesture, covering engines whose tap heuristics outlive the
 *    cancellation. The flag also clears when the sheet closes, since a click
 *    that never reaches the wrapper cannot clear it.
 *
 * The sheet must be rendered as a **sibling** of the element spread with
 * `wrapperProps`, never inside it: React propagates events through the React
 * tree even for portaled content, so a sheet nested under the wrapper would
 * have its own first tap swallowed by the capture handler.
 *
 *   const longPress = useLongPressSheet({ shouldSkip: SKIP_NESTED_CONTROLS });
 *
 *   <>
 *     <div className="contents" {...longPress.wrapperProps}>{row}</div>
 *     <ActionSheet open={longPress.open} onOpenChange={longPress.onOpenChange} />
 *   </>
 *
 * @see https://www.w3.org/TR/touch-events/#compatibility-mouse-events
 */

import {
  useCallback,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type TouchEvent as ReactTouchEvent,
} from "react";

import { useLongPress } from "@/hooks/use-long-press";

export interface UseLongPressSheetOptions {
  /**
   * Touch targets that should not arm the gesture — typically nested controls
   * that own their own taps. Define it at module scope so the returned
   * handlers stay referentially stable across renders.
   */
  shouldSkip?: (target: Element | null) => boolean;
}

export interface LongPressSheetWrapperProps {
  className: string;
  onClickCapture: (event: ReactMouseEvent) => void;
  onTouchStart: (event: ReactTouchEvent) => void;
  onTouchMove: (event: ReactTouchEvent) => void;
  onTouchEnd: (event: ReactTouchEvent) => void;
  onTouchCancel: (event: ReactTouchEvent) => void;
}

export interface UseLongPressSheetResult {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  close: () => void;
  /** Spread onto a wrapper that adds no layout box (`display: contents`). */
  wrapperProps: LongPressSheetWrapperProps;
}

export function useLongPressSheet({
  shouldSkip,
}: UseLongPressSheetOptions = {}): UseLongPressSheetResult {
  const [open, setOpen] = useState(false);
  const firedRef = useRef(false);

  const handlers = useLongPress(
    useCallback(() => {
      firedRef.current = true;
      setOpen(true);
    }, []),
    undefined,
    { ignoreInteractiveTarget: true, shouldSkip },
  );

  const onOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) {
      firedRef.current = false;
    }
  }, []);

  // Routed through `onOpenChange` rather than `setOpen`: closing by running an
  // action has to clear the guard too, otherwise it stays armed and eats the
  // next genuine tap on the surface.
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  const onClickCapture = useCallback((event: ReactMouseEvent) => {
    if (firedRef.current) {
      firedRef.current = false;
      event.preventDefault();
      event.stopPropagation();
    }
  }, []);

  /* Only a release that completed the gesture is cancelled, since a plain tap
     needs its click to reach the row. React registers `touchend` as an active
     listener, so the cancellation takes effect. A cancelled touch emits no
     compatibility sequence at all and needs nothing here. */
  const onTouchEnd = useCallback(
    (event: ReactTouchEvent) => {
      handlers.onTouchEnd();
      if (firedRef.current) {
        event.preventDefault();
      }
    },
    [handlers],
  );

  return {
    open,
    onOpenChange,
    close,
    wrapperProps: {
      className: "contents",
      onClickCapture,
      onTouchStart: handlers.onTouchStart,
      onTouchMove: handlers.onTouchMove,
      onTouchEnd,
      onTouchCancel: handlers.onTouchCancel,
    },
  };
}
