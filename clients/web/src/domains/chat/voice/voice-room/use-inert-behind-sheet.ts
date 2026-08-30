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
 * The sheet portals into `#viewport-overlays` inside the app shell, a host it
 * shares with the other mobile overlays. So the covered set is every element
 * sibling of that host, plus every child of the host that is not the sheet's
 * own portal node. The route content under `<main>` already goes inert with
 * the room (`chat-layout.tsx`); this is the rest's share, held for exactly as
 * long as the sheet is flush. A node that arrived inert stays inert, since
 * that attribute is someone else's to remove. Both lists change under an open
 * camera (the status banner mounts beside the host when assistant state
 * changes; another overlay can mount inside it), so the gate watches both
 * child lists and covers late arrivals too.
 */

import { type RefObject, useEffect } from "react";

/** `RootLayout`'s portal container, inside the app shell's isolation. */
export const OVERLAY_HOST_ID = "viewport-overlays";

export function useInertBehindSheet(
  active: boolean,
  /** The sheet's dialog element, so its own portal node is left alone. */
  sheetRef: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!active) {
      return;
    }
    const host = document.getElementById(OVERLAY_HOST_ID);
    const shell = host?.parentElement;
    const sheet = sheetRef.current;
    if (!host || !shell || !sheet) {
      return;
    }
    const covered = new Set<Element>();
    const cover = (element: Element) => {
      if (
        element === host ||
        element.contains(sheet) ||
        element.hasAttribute("inert")
      ) {
        return;
      }
      element.setAttribute("inert", "");
      covered.add(element);
    };
    for (const element of Array.from(shell.children)) {
      cover(element);
    }
    for (const element of Array.from(host.children)) {
      cover(element);
    }
    // Direct children of each list only: churn inside the sheet never lands
    // here.
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (node instanceof Element) {
            cover(node);
          }
        }
      }
    });
    observer.observe(shell, { childList: true });
    observer.observe(host, { childList: true });
    return () => {
      observer.disconnect();
      for (const element of covered) {
        element.removeAttribute("inert");
      }
    };
  }, [active, sheetRef]);
}
