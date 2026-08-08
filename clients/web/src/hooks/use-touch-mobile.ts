import {
  TOUCH_SURFACE_MEDIA_QUERY,
  useTouchSurface,
} from "@vellumai/design-library/utils/touch-surface";

/**
 * The input-capability signal: a narrow viewport with a coarse pointer, i.e. a
 * real touch device (iOS, Android) rather than a desktop browser or Electron
 * window someone shrank. How much fits on screen is `useIsMobile()`. See
 * `docs/PLATFORM_ADAPTATION.md`.
 *
 * The query itself is defined once in the design library, alongside the
 * `touch-mobile` CSS variant it has to agree with, and is re-exported here so
 * app code has a single module to import (and tests a single module to stub).
 * Imported from the utility's own entry point rather than the package root, so
 * a test that stubs the design library's components does not take the signal
 * with it.
 */
export const TOUCH_MOBILE_MEDIA_QUERY = TOUCH_SURFACE_MEDIA_QUERY;

export function useTouchMobile(): boolean {
  return useTouchSurface();
}
