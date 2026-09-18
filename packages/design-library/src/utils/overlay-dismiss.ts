import { useRef, type MouseEvent, type PointerEvent } from "react";

/**
 * The handlers a dialog overlay needs to dismiss itself when the backdrop is
 * pressed.
 *
 * Two things make this more than an `onClick`.
 *
 * The click is needed at all because iOS Safari and WKWebView dispatch `click`
 * only from elements they consider clickable, which a bare overlay div is not.
 * Radix's `DismissableLayer` defers touch dismissal to a document `click`
 * listener, so without a handler of its own the overlay never dismisses under
 * a thumb.
 *
 * The press and the release are needed because the click alone does not say
 * where the gesture happened. A browser dispatches `click` on the nearest
 * common ancestor of the press and release targets, and the overlay is that
 * ancestor for any gesture that touches both it and the dialog: a press on a
 * control inside a dialog that has opened a menu (the menu's layer sets the
 * dialog's content to `pointer-events: none`, so the release falls through to
 * the overlay showing behind it), or a drag that starts on the backdrop and
 * ends on the dialog. Reading the click alone dismisses in both. So the
 * backdrop dismisses only for a gesture whose press and release both landed
 * on it.
 *
 * @see https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/HandlingEvents/HandlingEvents.html
 * @see https://www.w3.org/TR/uievents/#event-type-click
 */
export interface OverlayDismissOptions {
  /** Called for a press and release on the backdrop itself. */
  onDismiss?: () => void;
  /** `false` leaves the backdrop inert, for a dialog that must be answered. */
  enabled?: boolean;
}

export interface OverlayDismissHandlers {
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLElement>) => void;
  onClick: (event: MouseEvent<HTMLElement>) => void;
}

function onBackdrop(event: {
  target: EventTarget | null;
  currentTarget: EventTarget | null;
}): boolean {
  return event.target === event.currentTarget;
}

export function useOverlayDismiss({
  onDismiss,
  enabled = true,
}: OverlayDismissOptions): OverlayDismissHandlers {
  const gesture = useRef({ pressed: false, released: false });

  return {
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      gesture.current = { pressed: onBackdrop(event), released: false };
    },
    // A release on the dialog never reaches an overlay that is its sibling, so
    // this reads false for the sheet's shape as well as for the modal's.
    onPointerUp: (event: PointerEvent<HTMLElement>) => {
      gesture.current.released = onBackdrop(event);
    },
    onClick: (event: MouseEvent<HTMLElement>) => {
      const { pressed, released } = gesture.current;
      gesture.current = { pressed: false, released: false };
      if (!enabled || !pressed || !released) {
        return;
      }
      if (!onBackdrop(event)) {
        return;
      }
      onDismiss?.();
    },
  };
}
