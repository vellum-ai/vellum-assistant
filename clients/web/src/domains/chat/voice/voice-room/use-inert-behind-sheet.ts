/**
 * Hold the app shell inert while the voice sheet covers it.
 *
 * The mobile sheet is non-modal on purpose: resting below the thread header
 * only means anything if that header stays lit and usable (see
 * `VoiceRoomSheet`). Flush to the top of the screen for the camera, it covers
 * the header and the status banner instead, and leaving them tabbable and
 * speakable behind an opaque viewfinder is the reach the non-modal sheet was
 * never meant to leave open.
 *
 * Radix cannot answer that by going modal for the camera: it renders a
 * different content component per `modal`, so flipping the prop mid-session
 * remounts the sheet, replays the slide-up and tears down the live preview.
 * The attribute does the same job without touching the tree: `inert` takes a
 * subtree out of the tab order and the accessibility tree at once.
 *
 * The sheet portals into `#viewport-overlays` inside the app shell, so
 * everything it covers is an element sibling of that host. The route content
 * under `<main>` already goes inert with the room (`chat-layout.tsx`); this is
 * the header's and the banner's share, held for exactly as long as the sheet
 * is flush. A sibling that arrived inert stays inert, since that attribute is
 * someone else's to remove.
 */

import { useEffect } from "react";

/** `RootLayout`'s portal container, inside the app shell's isolation. */
export const OVERLAY_HOST_ID = "viewport-overlays";

export function useInertBehindSheet(active: boolean): void {
  useEffect(() => {
    if (!active) {
      return;
    }
    const host = document.getElementById(OVERLAY_HOST_ID);
    const shell = host?.parentElement;
    if (!host || !shell) {
      return;
    }
    const covered = Array.from(shell.children).filter(
      (element) => element !== host && !element.hasAttribute("inert"),
    );
    for (const element of covered) {
      element.setAttribute("inert", "");
    }
    return () => {
      for (const element of covered) {
        element.removeAttribute("inert");
      }
    };
  }, [active]);
}
