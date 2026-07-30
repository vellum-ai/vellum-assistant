/**
 * Live measurement of the voice room's own box.
 *
 * On desktop the room is a panel inset inside the layout's `<main>`, so its box
 * and the window are different rectangles. Every piece of the room's geometry
 * (eye sizing, the body's cover scale, the responding rings, the entrance
 * origin) scales against the room, and reading `window.innerWidth`/`innerHeight`
 * instead would overshoot it: the eyes would be drawn for a viewport the room
 * does not own, and the entrance would grow from a point outside it.
 *
 * `useRoomBox` reports both the size, which the geometry scales against, and the
 * viewport offset, which converts a viewport-space point (the entry origin the
 * composer publishes from a `getBoundingClientRect()`) into the room-local space
 * the look lays out in.
 *
 * Measurement is synchronous in `useLayoutEffect`, before paint, so the room's
 * entrance animation starts from a real box on its first painted frame rather
 * than growing from a zero-sized one. After mount a `ResizeObserver` tracks the
 * panel's own size (the sidebar collapsing, a rail drag), and a window `resize`
 * listener catches offset changes the observer does not fire for, since the box
 * can slide without changing size.
 */

import { useCallback, useLayoutEffect, useRef, useState } from "react";

export interface RoomBox {
  /** Room width in CSS px. The look's geometry scales against this. */
  w: number;
  /** Room height in CSS px. */
  h: number;
  /** Viewport x of the room's left edge; subtract to get room-local x. */
  left: number;
  /** Viewport y of the room's top edge; subtract to get room-local y. */
  top: number;
}

/**
 * Convert a viewport-space point into the room's local space.
 *
 * The composer publishes the entry origin as a viewport point (it measures the
 * avatar the user tapped with `getBoundingClientRect()`), but the look lays out
 * against the room box, so an unconverted origin lands outside the panel by
 * however far the panel is inset and the room grows from the wrong corner. Pure
 * so the arithmetic is testable without a DOM.
 *
 * Not clamped: an origin genuinely outside the panel (a tap in the sidenav)
 * should stay outside it, so the entrance flies in from that direction.
 */
export function toRoomLocal(
  point: { x: number; y: number } | null,
  box: RoomBox | null,
): { x: number; y: number } | null {
  if (!point || !box) {
    return null;
  }
  return { x: point.x - box.left, y: point.y - box.top };
}

/**
 * Measure the element the returned ref is attached to. `box` is `null` until
 * the first (pre-paint) measurement lands, so callers can hold geometry-
 * dependent children back for that one commit rather than render them against
 * a zero box.
 */
export function useRoomBox(): {
  ref: (node: HTMLElement | null) => void;
  box: RoomBox | null;
} {
  const nodeRef = useRef<HTMLElement | null>(null);
  const [box, setBox] = useState<RoomBox | null>(null);

  const measure = useCallback(() => {
    const node = nodeRef.current;
    if (!node) {
      return;
    }
    const rect = node.getBoundingClientRect();
    setBox((prev) =>
      prev &&
      prev.w === rect.width &&
      prev.h === rect.height &&
      prev.left === rect.left &&
      prev.top === rect.top
        ? prev
        : {
            w: rect.width,
            h: rect.height,
            left: rect.left,
            top: rect.top,
          },
    );
  }, []);

  // Callback ref rather than `useRef` + effect: the node must be captured and
  // measured in the same commit the room first renders in, so the entrance has
  // a box to grow inside.
  const ref = useCallback(
    (node: HTMLElement | null) => {
      nodeRef.current = node;
      if (node) {
        measure();
      }
    },
    [measure],
  );

  useLayoutEffect(() => {
    const node = nodeRef.current;
    if (!node) {
      return;
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    // A ResizeObserver only fires on size changes; the panel's viewport offset
    // also moves when the window itself resizes around a same-sized room.
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  return { ref, box };
}
