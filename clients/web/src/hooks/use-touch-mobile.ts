import { useSyncExternalStore } from "react";

/**
 * Mirrors the design-library `touch-mobile` CSS variant: a narrow viewport
 * with a coarse pointer, i.e. real touch devices (iOS, Android) rather than
 * desktop browsers or Electron. Keep this query in sync with the
 * `@custom-variant touch-mobile` definition in the design library.
 */
export const TOUCH_MOBILE_MEDIA_QUERY =
  "(max-width: 767px) and (pointer: coarse)";

function subscribe(onChange: () => void): () => void {
  const mql = window.matchMedia(TOUCH_MOBILE_MEDIA_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  return window.matchMedia(TOUCH_MOBILE_MEDIA_QUERY).matches;
}

/** Returns `true` on touch-first mobile viewports (see the media query). */
export function useTouchMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
