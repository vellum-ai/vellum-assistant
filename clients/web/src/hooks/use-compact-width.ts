/**
 * Whether a chat-column surface has room for its roomy layout, measured against
 * the surface itself rather than the viewport.
 *
 * Everything stacked in `ChatColumn` (the composer, the question card, the
 * connect card) is the same width and narrows together when the sidebar opens
 * or the window is split, so they share one threshold. A viewport query would
 * miss all of that, and a CSS container query cannot hand the boolean to the
 * behavior that reads it: which controls mount, whether a gesture arms, and
 * whether a surface is inert. See `docs/PLATFORM_ADAPTATION.md`.
 */

import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * Width (px) below which a chat-column surface drops to its compact layout.
 * Set by the composer's action row, which is the tightest of them: below this
 * its labelled access and model-profile triggers overlap.
 */
export const COMPACT_WIDTH_PX = 520;

/**
 * Extra width a compact surface must regain before it expands again.
 *
 * The sidebar rail animates on `cubic-bezier(0.34, 1.56, 0.64, 1)`, which
 * overshoots its target by roughly 10% before settling. The chat column takes
 * the complement, so one sidebar toggle can carry a surface across the
 * threshold, back, and across again. This band is wider than that overshoot, so
 * the layout settles once. It only ever holds a surface in the compact layout
 * for longer, never the reverse, so nothing collides while it waits.
 */
const COMPACT_WIDTH_RELEASE_PX = 24;

/**
 * True while `ref`'s element is narrower than {@link COMPACT_WIDTH_PX}.
 *
 * An element that has not been laid out reports a zero box, which counts as
 * compact: the roomy layout is the one that needs room proven.
 */
export function useIsCompactWidth(ref: RefObject<HTMLElement | null>): boolean {
  const [compact, setCompact] = useState(true);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }

    const apply = (width: number) => {
      setCompact(
        (wasCompact) =>
          width <
          COMPACT_WIDTH_PX + (wasCompact ? COMPACT_WIDTH_RELEASE_PX : 0),
      );
    };

    // Before paint, so the first frame is already the right layout.
    apply(el.getBoundingClientRect().width);

    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const inlineSize = entries[0]?.borderBoxSize?.[0]?.inlineSize;
      // Reading the entry keeps a collapse animation, which notifies on every
      // frame it changes height, from forcing a measurement per frame.
      apply(inlineSize ?? el.getBoundingClientRect().width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return compact;
}
