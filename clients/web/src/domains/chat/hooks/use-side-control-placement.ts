/**
 * Whether the chat column has a gutter wide enough to float the side controls
 * in, or whether they have to move above the thread instead.
 *
 * The transcript is centred and capped at `--chat-max-width`, so a wide column
 * leaves an empty strip either side and the controls can sit in the right one
 * without covering anything. As the column narrows (a drawer opens, the window
 * shrinks, the sidebar widens) that strip closes, and controls pinned to the
 * right edge start overlapping the messages they are meant to annotate.
 *
 * Measured rather than assumed from a breakpoint, because the column's width is
 * not a function of the viewport: the same window is wide or narrow depending
 * on whether a document viewer is open beside it.
 *
 * Reads the cap from the CSS custom property instead of hardcoding 800px, so a
 * change to the token moves this with it.
 */

import { useEffect, useState, type RefObject } from "react";

/**
 * Gutter needed before the controls are allowed to float in it: the widest
 * control (the agents pill with its stacked marks) plus enough clearance that
 * it never crowds the text.
 */
const REQUIRED_GUTTER_PX = 140;

/** Fallback when the custom property is missing or unparseable (e.g. jsdom). */
const CHAT_MAX_WIDTH_FALLBACK_PX = 800;

function readChatMaxWidth(el: Element): number {
  const raw = getComputedStyle(el).getPropertyValue("--chat-max-width");
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : CHAT_MAX_WIDTH_FALLBACK_PX;
}

/**
 * `true` when the controls fit in the column's right gutter; `false` when they
 * must move above the thread.
 *
 * Defaults to `false` before the first measurement: stacking above the chat is
 * always correct, just less pretty, whereas floating over a column that turns
 * out to be narrow overlaps the text. So the pre-measure frame errs safe.
 */
export function useSideControlsFitGutter(
  ref: RefObject<HTMLElement | null>,
): boolean {
  const [fits, setFits] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") {
      return;
    }
    const measure = () => {
      const width = el.getBoundingClientRect().width;
      if (width === 0) {
        // Hidden or not laid out yet; hold the current answer rather than
        // flipping to "doesn't fit" and back on the next frame.
        return;
      }
      const gutter = (width - readChatMaxWidth(el)) / 2;
      setFits(gutter >= REQUIRED_GUTTER_PX);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return fits;
}
