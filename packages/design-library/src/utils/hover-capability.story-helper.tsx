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

/**
 * Installed from a `useState` initializer, which runs during this component's
 * render and so before any child samples the query. An identity check against
 * the saved original would not work as the teardown condition: `bind` returns a
 * new function object, so it never compares equal to the global.
 *
 * Only the hover query is answered here; everything else is passed to the real
 * `matchMedia`, so a story stays truthful about its width and its pointer.
 */
export function WithoutHover({ children }: { children: ReactNode }) {
  const [original] = useState(() => {
    const saved = window.matchMedia.bind(window);
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
    return saved;
  });

  useEffect(() => {
    return () => setMatchMedia(original);
  }, [original]);

  return <>{children}</>;
}
