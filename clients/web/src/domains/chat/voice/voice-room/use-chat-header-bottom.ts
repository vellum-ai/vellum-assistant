/**
 * Viewport y of the chat layout's thread header's bottom edge, in CSS px.
 *
 * The mobile voice room is a bottom sheet that rests below the header rather
 * than covering it. The sheet is a Radix dialog, so it portals to the body and
 * positions itself `fixed`, outside the layout's flex column: it cannot inherit
 * "starts below the header" from the DOM the way the desktop panel does, and it
 * has to be told where that edge is.
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

import { CHAT_LAYOUT_HEADER_SELECTOR } from "@/domains/chat/chat-layout-header";

export function useChatHeaderBottom(): number {
  const [bottom, setBottom] = useState(0);

  useEffect(() => {
    const header = document.querySelector(CHAT_LAYOUT_HEADER_SELECTOR);
    if (!header) {
      setBottom(0);
      return;
    }
    const measure = () => {
      setBottom(header.getBoundingClientRect().bottom);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    // The observer covers the header's own box changing. Its viewport offset
    // moves for reasons the observer never sees: a rotation changing the notch
    // inset, or the iOS keyboard opening and shifting the whole shell down.
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("scroll", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("scroll", measure);
    };
  }, []);

  return bottom;
}
