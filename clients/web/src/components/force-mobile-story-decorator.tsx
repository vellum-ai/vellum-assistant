/**
 * Story decorator that pins `useIsMobile()` to true, for the compositions whose
 * mobile branch is the thing being reviewed.
 */

import { useEffect, useState } from "react";
import type { Decorator } from "@storybook/react-vite";

import { MOBILE_MEDIA_QUERY } from "@/hooks/use-is-mobile";

/** Swap `window.matchMedia`; `configurable` so the teardown can put it back. */
function setMatchMedia(impl: typeof window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    value: impl,
    configurable: true,
    writable: true,
  });
}

/**
 * Forces the mobile branch of `useIsMobile` for the duration of the story.
 *
 * Overriding the media query beats resizing the preview iframe: the story then
 * shows the mobile composition regardless of the viewport the docs page happens
 * to render at.
 */
export const forceMobile: Decorator = function ForceMobile(Story) {
  // Installed from a `useState` initializer, which runs exactly once and during
  // this decorator's render, i.e. before the story samples the query. An
  // identity check against the saved original would not work here: `bind`
  // returns a new function object, so it never compares equal to the global.
  const [original] = useState(() => {
    const saved = window.matchMedia.bind(window);
    setMatchMedia(((query: string) => {
      const result = saved(query);
      if (query !== MOBILE_MEDIA_QUERY) {
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
  return <Story />;
};
