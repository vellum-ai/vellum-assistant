/**
 * A decorator that forces the design library's touch-surface branch for the
 * duration of a story, so a story of a phone's bottom sheet draws the sheet
 * rather than the pointer presentation beside it.
 *
 * A viewport global narrows the preview iframe and nothing else, and the
 * touch-surface signal is a narrow viewport AND a coarse pointer, so a desktop
 * browser running a phone-width story still gets the pointer surface.
 * Overriding the query is the only seam the library offers: it reads
 * `window.matchMedia` directly rather than through a provider.
 */

import { useEffect, useState, type ReactNode } from "react";
import type { Decorator } from "@storybook/react-vite";

import { TOUCH_SURFACE_MEDIA_QUERY } from "@vellumai/design-library";

/** Swap `window.matchMedia`; `configurable` so the teardown can put it back. */
function setMatchMedia(impl: typeof window.matchMedia): void {
  Object.defineProperty(window, "matchMedia", {
    value: impl,
    configurable: true,
    writable: true,
  });
}

function ForceTouchSurface({ children }: { children: ReactNode }): ReactNode {
  // Installed from a `useState` initializer, which runs exactly once and during
  // this component's render, i.e. before any child samples the query. An
  // identity check against the saved original would not work here: `bind`
  // returns a new function object, so it never compares equal to the global.
  const [original] = useState(() => {
    const saved = window.matchMedia.bind(window);
    setMatchMedia(((query: string) => {
      const result = saved(query);
      if (query !== TOUCH_SURFACE_MEDIA_QUERY) {
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
  useEffect(() => () => setMatchMedia(original), [original]);
  return <>{children}</>;
}

/** Pairs with a phone viewport global: the viewport alone is not the signal. */
export const withTouchSurface: Decorator = (Story) => (
  <ForceTouchSurface>
    <Story />
  </ForceTouchSurface>
);
