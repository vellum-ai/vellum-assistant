/**
 * Viewport y of the chat layout's thread header's bottom edge, in CSS px.
 *
 * Every surface that needs this edge is portalled out of the layout that
 * already knows it: the mobile voice room is a Radix dialog that portals to the
 * body, and the onboarding tour's takeover portals there too. Both position
 * themselves `fixed`, outside the layout's flex column, so neither can inherit
 * "starts below the header" from the DOM the way the desktop panel does, and
 * both have to be told where that edge is. One owner for the answer, so a
 * second surface cannot disagree with the first about where the header ends.
 *
 * The edge is measured in JavaScript rather than expressed in CSS because it
 * moves with the iOS keyboard through `visualViewport` scroll, which no CSS
 * unit or media query can observe.
 *
 * The value is the header's `bottom` in viewport coordinates, NOT its height.
 * The two are equal only when the header starts at y=0, and it usually does
 * not: `root-layout.tsx` pads the app shell above the header by the notch
 * inset, and stacks the iOS keyboard's scroll compensation on top of that when
 * the keyboard is open. A `fixed` element positioned by height alone sits that
 * much too high and overlaps the very header it is meant to rest below.
 *
 * Reading it live also covers the parts that move: the header is 40px on mobile
 * web and 44px in Electron, carries `pt-4` plus a conditional `pb-4`, and its
 * offset changes with orientation and with the keyboard.
 *
 * The header is found by its `data-slot`, the attribute the design library's
 * conventions establish for exactly this kind of outside-in reference. Absent
 * (pop-out windows render no header), the offset is 0, which is also the
 * correct answer for a surface with nothing above it.
 */

import { useEffect, useState } from "react";

/** The header's own `data-slot`, set in `chat-layout-header.tsx`. */
const HEADER_SELECTOR = '[data-slot="chat-layout-header"]';

export function useChatHeaderBottom(): number {
  const [bottom, setBottom] = useState(0);

  useEffect(() => {
    const header = document.querySelector(HEADER_SELECTOR);
    if (!header) {
      setBottom(0);
      return;
    }
    const measure = () => {
      setBottom(header.getBoundingClientRect().bottom);
    };
    const observer = new ResizeObserver(measure);
    // Anything laid out above the header in the same flow moves this edge
    // without changing the header's own box: on a phone an off-conversation
    // voice session rides above it as a full-width row and pushes it down. So
    // the whole row of siblings is observed, not just the header. `observe` is
    // idempotent, so re-observing on later mutations is safe.
    const row = header.parentElement;
    const observeRow = () => {
      for (const sibling of Array.from(row?.children ?? [])) {
        observer.observe(sibling);
      }
    };
    measure();
    observer.observe(header);
    observeRow();
    // A sibling mounting or unmounting (that session starting or ending)
    // displaces the header without resizing anything already observed, so
    // watch the row for child add/remove and pick up any late arrival.
    let rowObserver: MutationObserver | undefined;
    if (row && typeof MutationObserver !== "undefined") {
      rowObserver = new MutationObserver(() => {
        observeRow();
        measure();
      });
      rowObserver.observe(row, { childList: true });
    }
    // The observers cover boxes changing. The header's viewport offset also
    // moves for reasons no box change reports: a rotation changing the notch
    // inset, or the iOS keyboard opening and shifting the whole shell down.
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("scroll", measure);
    return () => {
      observer.disconnect();
      rowObserver?.disconnect();
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("scroll", measure);
    };
  }, []);

  return bottom;
}
