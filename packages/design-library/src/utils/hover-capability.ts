/**
 * The input-capability signal for affordances that only hover can reveal.
 *
 * `hover` is independent of `pointer` and of viewport width, so it is the only
 * axis that answers whether a hover-revealed surface is reachable at all: an
 * iPad in landscape reports `hover: none` at 1024px, and a desktop window
 * narrowed to 600px keeps its mouse. This is the same question the reveal rules
 * in `tokens.css` ask, so a component deciding in TypeScript whether to mount a
 * hover-only surface and the CSS deciding whether to paint one stay in
 * agreement. `hover-capability.test.ts` parses those blocks and fails if the
 * two drift.
 *
 * The query is the negative one, and that is deliberate. A surface is treated as
 * hover-capable unless the device affirmatively reports that it cannot hover, so
 * every environment that does not evaluate media features at all (server
 * rendering, a test DOM, a stub that answers `false` to everything) keeps the
 * hover behaviour rather than losing it. Failing the other way would silently
 * strip tooltips wherever the signal is merely unknown, which is a far larger
 * blast radius than leaving one on a device that turns out not to want it.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/CSS/@media/hover
 */

import { useCallback, useSyncExternalStore } from "react";

export const HOVER_ABSENT_MEDIA_QUERY = "(hover: none)";

/**
 * Whether the current device can hover (see {@link HOVER_ABSENT_MEDIA_QUERY}).
 * Re-renders when that changes, so plugging a mouse into a tablet or moving a
 * window to another display is picked up without a reload.
 *
 * Prefer letting a primitive read this over reading it in a caller: a caller
 * that drops its own tooltip on touch is re-deciding a question every caller
 * answers the same way.
 */
export function useHoverCapable(): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const query = window.matchMedia(HOVER_ABSENT_MEDIA_QUERY);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const getSnapshot = useCallback(
    () => !window.matchMedia(HOVER_ABSENT_MEDIA_QUERY).matches,
    [],
  );

  return useSyncExternalStore(subscribe, getSnapshot, () => true);
}
