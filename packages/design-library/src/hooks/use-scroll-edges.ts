/**
 * Which edges of a scroll container have content hidden past them on one axis,
 * followed as it scrolls and as its box or its content resizes, and the mask
 * that fades exactly those edges. `ScrollShadow` fades a list with it; `Table`
 * uses it to know it is wider than its host.
 *
 * The element arrives through a callback ref stored in state, so the hook
 * measures once it mounts. A `ResizeObserver` watches the container and its
 * first child: the container's box changes with the viewport, and a capped
 * container never resizes when only its content grows. Every render measures
 * again as well, for content that changes without resizing either.
 */

import { useCallback, useEffect, useLayoutEffect, useState } from "react";

export type ScrollAxis = "vertical" | "horizontal";

/** Which edges fade: both, only the start (top / left), or only the end. */
export type ScrollFadeEdges = "both" | "start" | "end";

export interface ScrollEdges {
  /** Content is hidden before the visible start (top / left). */
  start: boolean;
  /** Content is hidden past the visible end (bottom / right). */
  end: boolean;
}

const NO_EDGES: ScrollEdges = { start: false, end: false };

interface UseScrollEdgesOptions {
  /** Scroll distance past an edge before it stops counting as hidden. */
  offset?: number;
  /** When false, reports no hidden edges without measuring. */
  enabled?: boolean;
}

export function useScrollEdges<T extends HTMLElement>(
  axis: ScrollAxis,
  { offset = 0, enabled = true }: UseScrollEdgesOptions = {},
): { ref: (el: T | null) => void; edges: ScrollEdges } {
  const [el, setEl] = useState<T | null>(null);
  const [edges, setEdges] = useState<ScrollEdges>(NO_EDGES);

  const measure = useCallback(() => {
    if (!el || !enabled) {
      setEdges(NO_EDGES);
      return;
    }
    const vertical = axis === "vertical";
    const position = vertical ? el.scrollTop : el.scrollLeft;
    const max = vertical
      ? el.scrollHeight - el.clientHeight
      : el.scrollWidth - el.clientWidth;
    const start = position > offset;
    const end = position < max - offset;
    setEdges((prev) =>
      prev.start === start && prev.end === end ? prev : { start, end },
    );
  }, [el, enabled, axis, offset]);

  useLayoutEffect(() => {
    measure();
  });

  useEffect(() => {
    if (!el) {
      return;
    }
    el.addEventListener("scroll", measure, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(el);
    if (el.firstElementChild) {
      observer?.observe(el.firstElementChild);
    }
    return () => {
      el.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [el, measure]);

  return { ref: setEl, edges };
}

/**
 * A `mask-image` that fades each edge with content hidden past it over `size`
 * pixels, and leaves the others solid. An edge left out of `fadeEdges`
 * contributes no stops, so the neighbouring stop carries to that end.
 */
export function scrollEdgeMask(
  axis: ScrollAxis,
  size: number,
  edges: ScrollEdges,
  fadeEdges: ScrollFadeEdges = "both",
): string {
  const direction = axis === "vertical" ? "to bottom" : "to right";
  const stops: string[] = [];
  if (fadeEdges !== "end") {
    stops.push(edges.start ? "transparent" : "#000", `#000 ${size}px`);
  }
  if (fadeEdges !== "start") {
    stops.push(
      `#000 calc(100% - ${size}px)`,
      edges.end ? "transparent" : "#000",
    );
  }
  return `linear-gradient(${direction}, ${stops.join(", ")})`;
}
