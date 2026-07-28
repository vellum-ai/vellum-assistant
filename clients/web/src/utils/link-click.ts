/**
 * Whether a mouse click on a link should fall through to the browser's native
 * anchor handling instead of being intercepted for client-side SPA navigation.
 *
 * True for modifier-key clicks (Cmd/Ctrl/Shift/Alt) and non-primary buttons
 * (middle/right) — those must open a new tab or window, or the context menu,
 * rather than trigger an in-app navigation. Plain left-clicks return false so
 * the caller can `preventDefault()` and navigate via react-router.
 */
export function isModifiedLinkClick(
  event: Pick<
    MouseEvent,
    "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "button"
  >,
): boolean {
  return (
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    event.button !== 0
  );
}
