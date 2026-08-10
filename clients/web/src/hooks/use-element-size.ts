/**
 * The size a decorative layer positions itself against, kept live.
 *
 * Two boxes qualify, so this module owns both and the fallback dimensions
 * they share: `useElementSize` for a container (via `ResizeObserver`) and
 * `useLayoutViewportSize` for the layout viewport (via `resize`).
 *
 * Which one a layer wants is the whole point of the split. Layers that anchor
 * to a container's edges (the onboarding stage, the About Assistant stage)
 * read the element box, so their `absolute` children resolve against the same
 * box the `%`-positioned foreground uses. That is what holds up on iOS, where
 * a `position: fixed` layer measured from `window.innerHeight` resolves
 * against the taller layout viewport instead of the container. Layers that
 * genuinely anchor to the screen edge, or that pair a size with a
 * (viewport-relative) `getBoundingClientRect()`, want the layout viewport.
 *
 * "Layout viewport" is deliberate, and is not a third name for the two things
 * that already carry one. It is `window.innerWidth` / `innerHeight`: the box
 * CSS resolves `%` and `dvh` against, which does NOT shrink when the soft
 * keyboard opens.
 *
 * - `useVisibleViewport` (`use-visible-viewport.ts`) is the *visual* viewport,
 *   which does shrink with the keyboard and reports no width. Sizing artwork
 *   from it would resize the artwork every time a field is focused.
 * - `useOnboardingWindowSize` (`use-onboarding-window-size.ts`) is the Electron
 *   OS window, driven over IPC. Nothing to do with either viewport.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Visual_Viewport_API#visual_viewport_vs._layout_viewport
 */

import { useLayoutEffect, useState, useSyncExternalStore } from "react";

export interface StageSize {
  w: number;
  h: number;
}

const FALLBACK: StageSize = { w: 1280, h: 800 };

export function layoutViewportSize(): StageSize {
  if (typeof window === "undefined") {
    return FALLBACK;
  }
  return { w: window.innerWidth, h: window.innerHeight };
}

/**
 * The layout viewport, as an external store: one `resize` listener and one
 * snapshot shared by every consumer, however many mount.
 *
 * `getSnapshot` reads live but returns the *previous* object whenever both
 * dimensions are unchanged. `useSyncExternalStore` calls it on every render
 * and bails out only on reference equality, so a freshly built `{ w, h }`
 * would re-render forever; this is the same caching contract
 * `typed-storage.ts` implements for its non-primitive snapshots. It also
 * means a `resize` that leaves the box alone (zoom, the iOS keyboard, an
 * orientation change that settles back) costs nothing downstream.
 */
let layoutViewportSnapshot: StageSize = FALLBACK;
const layoutViewportListeners = new Set<() => void>();

function notifyLayoutViewportResize(): void {
  for (const listener of layoutViewportListeners) {
    listener();
  }
}

function subscribeToLayoutViewport(onStoreChange: () => void): () => void {
  if (layoutViewportListeners.size === 0) {
    window.addEventListener("resize", notifyLayoutViewportResize);
  }
  layoutViewportListeners.add(onStoreChange);
  return () => {
    layoutViewportListeners.delete(onStoreChange);
    if (layoutViewportListeners.size === 0) {
      window.removeEventListener("resize", notifyLayoutViewportResize);
    }
  };
}

function getLayoutViewportSnapshot(): StageSize {
  const next = layoutViewportSize();
  if (
    next.w !== layoutViewportSnapshot.w ||
    next.h !== layoutViewportSnapshot.h
  ) {
    layoutViewportSnapshot = next;
  }
  return layoutViewportSnapshot;
}

function getLayoutViewportServerSnapshot(): StageSize {
  return FALLBACK;
}

/** Subscribe to nothing, for the opt-out below. */
const noopSubscribe = () => () => {};

/**
 * The layout viewport size, kept live on `resize`.
 *
 * Reach for CSS first. If what you are writing is a size or a position that
 * `clamp()`, `vmin`, `vw` or `%` can express, write it in CSS: it resolves
 * against a defined box automatically, updates without a React render, and
 * cannot disagree with the `%`-positioned foreground next to it. Most of this
 * app already sizes that way (`max-w-[min(520px,calc(100vw-8rem))]`,
 * `w-[90vw] max-w-[800px]`).
 *
 * This hook is for the cases CSS genuinely cannot reach: a number handed to
 * an animation library, or one paired with a `getBoundingClientRect()`. The
 * onboarding and voice decorative layers use it well beyond that,
 * computing `clamp()` in JavaScript, which is what LUM-3204 tracks. Adding a
 * consumer that CSS could have expressed makes that worse.
 *
 * Lives here rather than at the call site so the SSR fallback and the
 * `FALLBACK` dimensions keep one owner: a caller re-deriving this from
 * `window.innerWidth` ends up restating those constants, and then they drift
 * from the ones `layoutViewportSize` hands every other layer on the same
 * screen.
 *
 * Pass `enabled: false` when something else is supplying the size and this is
 * only a fallback. The value stays correct; it just stops subscribing.
 */
export function useLayoutViewportSize(enabled = true): StageSize {
  return useSyncExternalStore(
    enabled ? subscribeToLayoutViewport : noopSubscribe,
    getLayoutViewportSnapshot,
    getLayoutViewportServerSnapshot,
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
 * (e.g. a step that's conditionally rendered). Returns the layout viewport
 * size until the element mounts.
 */
export function useElementSize(): ElementSize {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [size, setSize] = useState<StageSize>(() => layoutViewportSize());

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
