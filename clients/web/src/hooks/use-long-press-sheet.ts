/**
 * Long-press → action-sheet plumbing, shared by every surface that swaps a
 * desktop right-click menu for a touch bottom sheet (sidebar conversation
 * rows, sidebar section headers).
 *
 * Wraps {@link useLongPress} with the four invariants that surface needs:
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
 * 4. **The sheet survives the release.** Where the compat click lands outside
 *    the sheet, a dismissable layer reads it as a click-outside and closes the
 *    sheet the gesture just opened, and the wrapper's handler cannot intercept
 *    it because the event is retargeted away from the row. The gesture
 *    therefore silences those events at the document until shortly after the
 *    finger lifts, which is earlier than any deliberate second tap.
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
  useEffect,
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

/**
 * How long after the finger lifts a mouse event can still be the release's own.
 * Browsers emit the compatibility sequence immediately, so this only has to
 * cover a few frames of delay, and it stays well inside the time it takes to
 * see a sheet animate in and reach for a row in it.
 */
const COMPAT_EVENT_WINDOW_MS = 150;

/**
 * The sequence a release emits, at most one of each. Silencing them by name and
 * once apiece leaves a deliberate second tap untouched.
 */
const COMPAT_EVENTS = ["mousedown", "mouseup", "click"] as const;

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
  /** The release's own events: those still owed, and when they stop being due. */
  const releaseRef = useRef<{ owed: Set<string>; until: number } | null>(null);

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

  // Captured at the document, so the events are gone before either the row or
  // the sheet's dismissable layer sees them: both listen further down. The
  // window expires on the next event rather than on a timer, so nothing has to
  // be cancelled when the row unmounts mid-gesture.
  useEffect(() => {
    const swallowRelease = (event: Event) => {
      const release = releaseRef.current;
      if (!release) {
        return;
      }

      if (event.timeStamp > release.until || !release.owed.delete(event.type)) {
        releaseRef.current = null;
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
    };

    for (const type of COMPAT_EVENTS) {
      document.addEventListener(type, swallowRelease, true);
    }

    return () => {
      for (const type of COMPAT_EVENTS) {
        document.removeEventListener(type, swallowRelease, true);
      }
    };
  }, []);

  /* The compatibility sequence follows the release, so the silence is armed by
     the release rather than by the gesture: a press that never lifts (or a row
     the user goes on interacting with) is not listening for events that cannot
     arrive yet. */
  const endGesture = useCallback((event: ReactTouchEvent) => {
    if (!firedRef.current) {
      return;
    }

    releaseRef.current = {
      owed: new Set(COMPAT_EVENTS),
      until: event.timeStamp + COMPAT_EVENT_WINDOW_MS,
    };
  }, []);

  const onTouchEnd = useCallback(
    (event: ReactTouchEvent) => {
      handlers.onTouchEnd();
      endGesture(event);
    },
    [endGesture, handlers],
  );

  const onTouchCancel = useCallback(
    (event: ReactTouchEvent) => {
      handlers.onTouchCancel();
      endGesture(event);
    },
    [endGesture, handlers],
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
      onTouchCancel,
    },
  };
}
