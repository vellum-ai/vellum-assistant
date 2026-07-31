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
 * 2. **The compatibility click is swallowed.** After a long-press fires, the
 *    browser still emits a click on touchend; without suppression it reaches
 *    the row/header underneath and navigates or toggles. `wrapperProps`
 *    carries a capture-phase handler that eats exactly that one click.
 * 3. **The flag clears when the sheet closes.** The compat click may never
 *    reach the wrapper (it can be routed to the sheet instead), so the guard
 *    is also reset on close rather than relying on the click alone.
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
  onTouchEnd: () => void;
  onTouchCancel: () => void;
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

  return {
    open,
    onOpenChange,
    close,
    wrapperProps: {
      className: "contents",
      onClickCapture,
      onTouchStart: handlers.onTouchStart,
      onTouchMove: handlers.onTouchMove,
      onTouchEnd: handlers.onTouchEnd,
      onTouchCancel: handlers.onTouchCancel,
    },
  };
}
