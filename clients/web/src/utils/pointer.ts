import { useMediaQuery } from "@/hooks/use-media-query";

/** The primary pointer being a coarse one, i.e. a finger rather than a mouse. */
const COARSE_POINTER_QUERY = "(pointer: coarse)";

/**
 * Whether the primary pointer is coarse (touch screen). Returns `false`
 * server-side. Coarse pointers imply a soft keyboard and touch-first
 * interaction model.
 *
 * A one-shot read: fine for anything that stands in for the shape the session
 * started in. Anything that must follow a pointer changing mid-session reads
 * {@link usePointerCoarse} instead.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/CSS/@media/pointer
 */
export function isPointerCoarse(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia(COARSE_POINTER_QUERY).matches
  );
}

/**
 * {@link isPointerCoarse} as a subscribed signal: re-renders when the primary
 * pointer changes, so a convertible whose keyboard comes off (or a tablet
 * docked into one) is picked up without a reload.
 *
 * The subscription, the snapshot and the `false` the server renders all come
 * from {@link useMediaQuery}, the same shared machinery behind `useIsMobile`.
 */
export function usePointerCoarse(): boolean {
  return useMediaQuery(COARSE_POINTER_QUERY);
}
