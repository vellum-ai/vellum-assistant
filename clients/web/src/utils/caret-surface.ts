/**
 * Single source of truth for the surfaces that own a drag for caret placement:
 * text fields and contenteditable regions. Dragging inside one moves the caret
 * and extends the selection, so a gesture layered over the page has to leave
 * that drag alone or it hijacks the user's editing.
 *
 * Both the edge-swipe engine (`use-edge-swipe`, for horizontal drags) and the
 * swipe-down keyboard dismissal (`use-swipe-down-dismiss-keyboard`, vertical)
 * key off this, so they must agree on what owns a caret. Each keeps its own
 * policy for selectable transcript text (`[data-message-text]`) on top: the
 * horizontal gesture excludes it outright, the vertical one only while a
 * selection is live. See AGENTS.md, Single Source of Truth.
 */
export const CARET_SURFACE_SELECTOR =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

/**
 * Whether `target` is, or is nested inside, a surface that owns caret drags
 * (see {@link CARET_SURFACE_SELECTOR}).
 */
export function ownsCaretDrag(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  return target.closest(CARET_SURFACE_SELECTOR) !== null;
}
