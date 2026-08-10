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

import { useLayoutEffect, useState, useSyncExternalStore } from "react";

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
 * The window, as an external store: one `resize` listener and one snapshot
 * shared by every consumer, however many mount.
 *
 * `getSnapshot` reads live but returns the *previous* object whenever both
 * dimensions are unchanged. `useSyncExternalStore` calls it on every render
 * and bails out only on reference equality, so a freshly built `{ w, h }`
 * would re-render forever; this is the same caching contract
 * `typed-storage.ts` implements for its non-primitive snapshots. It also
 * means a `resize` that leaves the box alone (zoom, the iOS keyboard, an
 * orientation change that settles back) costs nothing downstream.
 */
let windowSnapshot: StageSize = FALLBACK;
const windowListeners = new Set<() => void>();

function notifyWindowResize(): void {
  for (const listener of windowListeners) {
    listener();
  }
}

function subscribeToWindow(onStoreChange: () => void): () => void {
  if (windowListeners.size === 0) {
    window.addEventListener("resize", notifyWindowResize);
  }
  windowListeners.add(onStoreChange);
  return () => {
    windowListeners.delete(onStoreChange);
    if (windowListeners.size === 0) {
      window.removeEventListener("resize", notifyWindowResize);
    }
  };
}

function getWindowSnapshot(): StageSize {
  const next = windowSize();
  if (next.w !== windowSnapshot.w || next.h !== windowSnapshot.h) {
    windowSnapshot = next;
  }
  return windowSnapshot;
}

function getWindowServerSnapshot(): StageSize {
  return FALLBACK;
}

/** Subscribe to nothing, for the opt-out below. */
const noopSubscribe = () => () => {};

/**
 * The window size, kept live on `resize`.
 *
 * Lives here rather than at the call site so the SSR fallback and the
 * `FALLBACK` dimensions keep one owner: a caller re-deriving this from
 * `window.innerWidth` ends up restating those constants, and then they drift
 * from the ones `windowSize` hands every other layer on the same screen.
 *
 * Pass `enabled: false` when something else is supplying the size and the
 * window is only a fallback. The value stays correct; it just stops
 * subscribing to changes.
 */
export function useWindowSize(enabled = true): StageSize {
  return useSyncExternalStore(
    enabled ? subscribeToWindow : noopSubscribe,
    getWindowSnapshot,
    getWindowServerSnapshot,
  );
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
