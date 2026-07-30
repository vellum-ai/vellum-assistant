/**
 * Live height of the chat layout's thread header, in CSS px.
 *
 * The mobile voice room is a bottom sheet that rests below the header rather
 * than covering it. The sheet is a Radix dialog, so it portals to the body and
 * positions itself `fixed`, outside the layout's flex column: it cannot inherit
 * "starts below the header" from the DOM the way the desktop panel does, and it
 * has to be told where that edge is.
 *
 * The height is measured rather than assumed because it moves. The header is
 * 40px on mobile web and 44px in Electron, carries `pt-4` plus a conditional
 * `pb-4`, and sits under the notch inset on iOS, which changes with orientation.
 * A hardcoded offset would be wrong on most of those combinations.
 *
 * The header is found by its `data-slot`, the attribute the design library's
 * conventions establish for exactly this kind of outside-in reference. Absent
 * (pop-out windows render no header), the height is 0, which is also the
 * correct offset for a surface with nothing above it.
 */

import { useEffect, useState } from "react";

/** The header's own `data-slot`, set in `chat-layout-header.tsx`. */
const HEADER_SELECTOR = '[data-slot="chat-layout-header"]';

export function useChatHeaderHeight(): number {
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const header = document.querySelector(HEADER_SELECTOR);
    if (!header) {
      setHeight(0);
      return;
    }
    const measure = () => {
      setHeight(header.getBoundingClientRect().height);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    // The observer covers the header growing or shrinking. A rotation can also
    // change the notch inset without changing the header's own box, so the
    // window is watched too.
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  return height;
}
