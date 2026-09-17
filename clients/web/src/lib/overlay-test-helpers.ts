import { fireEvent } from "@testing-library/react";

/**
 * Tap the backdrop of a `Modal` or `BottomSheet` the way a browser reports it.
 *
 * The press and the release are what make it a backdrop tap. A browser
 * dispatches `click` on the nearest common ancestor of the two, so the overlay
 * receives one for any gesture that touches both it and the dialog, and
 * `useOverlayDismiss` dismisses only when both landed on the overlay itself.
 * Firing the click alone asserts something no user can produce.
 */
export function pressBackdrop(overlay: Element): void {
  fireEvent.pointerDown(overlay, { button: 0, ctrlKey: false });
  fireEvent.pointerUp(overlay, { button: 0 });
  fireEvent.click(overlay);
}
