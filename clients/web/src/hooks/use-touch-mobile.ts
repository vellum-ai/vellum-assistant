import { useMediaQuery } from "@/hooks/use-media-query";

/**
 * Mirrors the design-library `touch-mobile` CSS variant: a narrow viewport
 * with a coarse pointer, i.e. real touch devices (iOS, Android) rather than
 * desktop browsers or Electron. Keep this query in sync with the
 * `@custom-variant touch-mobile` definition in the design library.
 */
export const TOUCH_MOBILE_MEDIA_QUERY =
  "(max-width: 767px) and (pointer: coarse)";

/**
 * Returns `true` on touch-first mobile viewports (see the media query).
 *
 * This is the input-capability axis: which overlay a trigger should open,
 * whether long-press is the way in, whether a hover-revealed affordance can
 * exist at all. How much fits on screen is `useIsMobile()`. See
 * `docs/PLATFORM_ADAPTATION.md`.
 */
export function useTouchMobile(): boolean {
  return useMediaQuery(TOUCH_MOBILE_MEDIA_QUERY);
}
