/**
 * Makes a story's subtree report that it cannot hover, which is what an iPad or
 * a phone reports and what the browser running the stories does not. The
 * surfaces that stand down there (tooltips above all) are otherwise only
 * reachable on a real device.
 */

import { useEffect, useState, type ReactNode } from "react";

import { HOVER_ABSENT_MEDIA_QUERY } from "./hover-capability";

/** Swap `window.matchMedia`; `configurable` so the teardown can put it back. */
function setMatchMedia(impl: typeof window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    value: impl,
    configurable: true,
    writable: true,
  });
}

let leases = 0;
let realMatchMedia: typeof window.matchMedia | null = null;

/**
 * Install the no-hover `matchMedia` and get the matching release back. The
 * override is shared and counted because several stories mount together on an
 * autodocs page: a per-instance save/restore would capture a sibling's wrapper
 * as its "original" and reinstall it after the last unmount, leaving every
 * later story reporting no hover. Only the first acquire saves the real
 * function, and only the last release puts it back.
 *
 * Only the hover query is answered here; everything else is passed to the real
 * `matchMedia`, so a story stays truthful about its width and its pointer.
 */
export function acquireNoHoverMatchMedia(): () => void {
  if (leases === 0) {
    const saved = window.matchMedia.bind(window);
    realMatchMedia = saved;
    setMatchMedia(((query: string) => {
      const result = saved(query);
      if (query !== HOVER_ABSENT_MEDIA_QUERY) {
        return result;
      }
      return {
        ...result,
        media: query,
        matches: true,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      } as MediaQueryList;
    }) as typeof window.matchMedia);
  }
  leases += 1;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    leases -= 1;
    if (leases === 0 && realMatchMedia !== null) {
      setMatchMedia(realMatchMedia);
      realMatchMedia = null;
    }
  };
}

/**
 * Acquired from a `useState` initializer, which runs during this component's
 * render and so before any child samples the query.
 */
export function WithoutHover({ children }: { children: ReactNode }) {
  const [release] = useState(() => acquireNoHoverMatchMedia());
  useEffect(() => release, [release]);
  return <>{children}</>;
}
