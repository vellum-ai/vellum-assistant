/**
 * Live element-box measurement via `ResizeObserver`.
 *
 * Decorative layers that anchor to a container's edges (the onboarding
 * stage, the About Assistant stage) read this size to position
 * `absolute` children against the same box the `%`-positioned foreground
 * uses — robust on iOS, where a `position: fixed` layer measured from
 * `window.innerHeight` resolves against the taller layout viewport
 * instead of the container.
 */

import { useLayoutEffect, useState } from "react";

export interface StageSize {
  w: number;
  h: number;
}

const FALLBACK: StageSize = { w: 1280, h: 800 };

export function windowSize(): StageSize {
  if (typeof window === "undefined") return FALLBACK;
  return { w: window.innerWidth, h: window.innerHeight };
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
    if (!el) return;
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
