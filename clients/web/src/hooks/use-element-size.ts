/**
 * The size a decorative layer positions itself against, kept live.
 *
 * Two boxes qualify, so this module owns both and the fallback dimensions
 * they share: `useElementSize` for a container (via `ResizeObserver`) and
 * `useWindowSize` for the viewport (via `resize`).
 *
 * Which one a layer wants is the whole point of the split. Layers that anchor
 * to a container's edges (the onboarding stage, the About Assistant stage)
 * read the element box, so their `absolute` children resolve against the same
 * box the `%`-positioned foreground uses. That is what holds up on iOS, where
 * a `position: fixed` layer measured from `window.innerHeight` resolves
 * against the taller layout viewport instead of the container. Layers that
 * genuinely anchor to the screen edge, or that pair a size with a
 * (viewport-relative) `getBoundingClientRect()`, want the window instead.
 */

import { useEffect, useLayoutEffect, useState } from "react";

export interface StageSize {
  w: number;
  h: number;
}

const FALLBACK: StageSize = { w: 1280, h: 800 };

export function windowSize(): StageSize {
  if (typeof window === "undefined") {
    return FALLBACK;
  }
  return { w: window.innerWidth, h: window.innerHeight };
}

/**
 * The window size, kept live on `resize`.
 *
 * Lives here rather than at the call site so the SSR guard and the `FALLBACK`
 * dimensions keep one owner: a caller re-deriving this from
 * `window.innerWidth` ends up restating those constants, and then they drift
 * from the ones `windowSize` hands every other layer on the same screen.
 *
 * Re-renders only when a dimension actually changes. `resize` also fires for
 * things that leave the box alone (zoom, the iOS keyboard, an orientation
 * change that settles back), and a decorative layer has no reason to redraw
 * for those.
 *
 * Pass `enabled: false` when something else is supplying the size and the
 * window is only a fallback, to skip the listener entirely.
 */
export function useWindowSize(enabled = true): StageSize {
  const [size, setSize] = useState<StageSize>(() => windowSize());

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const onResize = () => {
      const next = windowSize();
      setSize((prev) => (prev.w === next.w && prev.h === next.h ? prev : next));
    };
    // The window can have changed between the initial render and this effect.
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [enabled]);

  return size;
}

export interface ElementSize {
  /** Callback ref — attach to the element to measure (`<div ref={ref}>`). */
  ref: (el: HTMLElement | null) => void;
  size: StageSize;
}

/**
 * Measure an element's box, kept live via `ResizeObserver`. Uses a callback
 * ref (stored in state) so it re-measures whenever the element
 * mounts/unmounts — robust to containers that appear after the first render
 * (e.g. a step that's conditionally rendered). Returns the window size
 * until the element mounts.
 */
export function useElementSize(): ElementSize {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [size, setSize] = useState<StageSize>(() => windowSize());

  useLayoutEffect(() => {
    if (!el) {
      return;
    }
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setSize({ w: rect.width, h: rect.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);

  return { ref: setEl, size };
}
